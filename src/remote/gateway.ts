import http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { createMcpHandler, Server, type Tool } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { DeviceRegistry, PairingManager } from "./device-auth.js";

interface ExtensionRpcResponse {
  id: string;
  ok: boolean;
  result?: any;
  error?: { code?: string; message?: string };
}

class ExtensionBridge {
  private socket: WebSocket | null = null;
  private pending = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  public attach(socket: WebSocket): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(4001, "Replaced by newer browserControl extension connection");
    }
    this.socket = socket;

    socket.on("message", (raw) => {
      let message: ExtensionRpcResponse | { type?: string };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!("id" in message) || !message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else {
        const error = new Error(message.error?.message || "Extension RPC failed");
        (error as any).code = message.error?.code || "EXTENSION_RPC_ERROR";
        pending.reject(error);
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("browserControl extension disconnected"));
        this.pending.delete(id);
      }
    });
  }

  public get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  public async call(method: string, params: Record<string, any> = {}, timeoutMs = 30_000): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const error = new Error("No browserControl extension is connected");
      (error as any).code = "DEVICE_OFFLINE";
      throw error;
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Extension RPC timed out: ${method}`);
        (error as any).code = "DEVICE_TIMEOUT";
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

class ControlLease {
  private owner: string | null = null;
  private expiresAt = 0;

  constructor(private readonly ttlMs = 60_000) {}

  public acquire(owner: string): boolean {
    const now = Date.now();
    if (!this.owner || this.owner === owner || now >= this.expiresAt) {
      this.owner = owner;
      this.expiresAt = now + this.ttlMs;
      return true;
    }
    return false;
  }

  public release(owner: string): void {
    if (this.owner === owner) {
      this.owner = null;
      this.expiresAt = 0;
    }
  }

  public status(): { owner: string | null; expiresAt: number } {
    if (this.owner && Date.now() >= this.expiresAt) {
      this.owner = null;
      this.expiresAt = 0;
    }
    return { owner: this.owner, expiresAt: this.expiresAt };
  }
}

class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  public consume(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const current = this.entries.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.entries.set(key, { startedAt: now, count: 1 });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (current.count >= this.limit) {
      return { allowed: false, retryAfterMs: Math.max(1, this.windowMs - (now - current.startedAt)) };
    }
    current.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
}

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;
const OBSERVATION_SCHEMA = {
  type: "object" as const,
  properties: { observationId: { type: "string" } },
  required: ["observationId"],
  additionalProperties: false,
};
const POINT_PROPERTIES = {
  observationId: { type: "string" },
  x: { type: "number", minimum: 0, maximum: 1000 },
  y: { type: "number", minimum: 0, maximum: 1000 },
} as const;

function toolError(error: any) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        success: false,
        errorCode: error?.code || "REMOTE_BROWSER_ERROR",
        message: error?.message || String(error),
      }),
    }],
    isError: true,
  };
}

function imageResult(observation: any) {
  const { image, mimeType, ...metadata } = observation;
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
      { type: "image" as const, data: image, mimeType },
    ],
  };
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function safeTokenEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function bearerToken(request: http.IncomingMessage): string {
  const value = request.headers.authorization || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "::";
}

function requestAddress(request: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(",")[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  return request.socket.remoteAddress || "unknown";
}

function writeJson(response: http.ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: http.IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" });
  }

  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (settled) return;
      size += Buffer.byteLength(chunk, "utf8");
      if (size > maxBytes) {
        settled = true;
        request.resume();
        reject(Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" }));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (settled) return;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(Object.assign(new Error(error instanceof Error ? error.message : "Invalid JSON body"), { code: "INVALID_JSON" }));
      }
    });
    request.on("error", reject);
  });
}

function tools(): Tool[] {
  return [
    {
      name: "browser_status",
      description: "Check browserControl connectivity, shared-tab state, local pause state, and exclusive-control lease status.",
      inputSchema: EMPTY_SCHEMA,
    },
    {
      name: "browser_observe",
      description: "Capture the currently shared Chrome tab. Coordinates use normalized 0-1000 values and mutating actions must reference the returned observationId.",
      inputSchema: {
        type: "object" as const,
        properties: {
          format: { type: "string", enum: ["jpeg", "png", "webp"], default: "jpeg" },
          quality: { type: "number", minimum: 1, maximum: 100, default: 82 },
          maxLongEdge: { type: "number", minimum: 480, maximum: 2000, default: 1280 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_inspect",
      description: "Capture a higher-detail sub-region of an observation. The returned crop has its own normalized 0-1000 coordinate space mapped back to the source viewport.",
      inputSchema: {
        type: "object" as const,
        properties: {
          observationId: { type: "string" },
          x: { type: "number", minimum: 0, maximum: 1000 },
          y: { type: "number", minimum: 0, maximum: 1000 },
          width: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
          height: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
          format: { type: "string", enum: ["jpeg", "png", "webp"], default: "png" },
          quality: { type: "number", minimum: 1, maximum: 100, default: 90 },
        },
        required: ["observationId", "x", "y", "width", "height"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_move",
      description: "Move/hover at normalized coordinates from a specific observation.",
      inputSchema: { type: "object" as const, properties: POINT_PROPERTIES, required: ["observationId", "x", "y"], additionalProperties: false },
    },
    {
      name: "browser_click",
      description: "Click at normalized coordinates from a specific observation. Stale observations are rejected.",
      inputSchema: {
        type: "object" as const,
        properties: { ...POINT_PROPERTIES, button: { type: "string", enum: ["left", "right", "middle"], default: "left" } },
        required: ["observationId", "x", "y"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_double_click",
      description: "Double-click at normalized coordinates from a specific observation.",
      inputSchema: {
        type: "object" as const,
        properties: { ...POINT_PROPERTIES, button: { type: "string", enum: ["left", "right", "middle"], default: "left" } },
        required: ["observationId", "x", "y"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_drag",
      description: "Drag through a normalized waypoint path planned against one observation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          observationId: { type: "string" },
          path: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              properties: {
                x: { type: "number", minimum: 0, maximum: 1000 },
                y: { type: "number", minimum: 0, maximum: 1000 },
              },
              required: ["x", "y"],
              additionalProperties: false,
            },
          },
        },
        required: ["observationId", "path"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_scroll",
      description: "Scroll at normalized coordinates using CSS-pixel wheel deltas.",
      inputSchema: {
        type: "object" as const,
        properties: {
          observationId: { type: "string" },
          x: { type: "number", minimum: 0, maximum: 1000, default: 500 },
          y: { type: "number", minimum: 0, maximum: 1000, default: 500 },
          deltaX: { type: "number", default: 0 },
          deltaY: { type: "number" },
        },
        required: ["observationId", "deltaY"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_type",
      description: "Insert text into the focused element only if the referenced observation is still current.",
      inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, text: { type: "string" } }, required: ["observationId", "text"], additionalProperties: false },
    },
    {
      name: "browser_keypress",
      description: "Send a keyboard shortcut only if the referenced observation is still current.",
      inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, keys: { type: "array", minItems: 1, items: { type: "string" } } }, required: ["observationId", "keys"], additionalProperties: false },
    },
    {
      name: "browser_navigate",
      description: "Navigate the currently shared tab to an absolute URL from a fresh observation.",
      inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, url: { type: "string", format: "uri" } }, required: ["observationId", "url"], additionalProperties: false },
    },
    { name: "browser_back", description: "Navigate backward from a fresh observation.", inputSchema: OBSERVATION_SCHEMA },
    { name: "browser_forward", description: "Navigate forward from a fresh observation.", inputSchema: OBSERVATION_SCHEMA },
    { name: "browser_reload", description: "Reload the shared tab from a fresh observation.", inputSchema: OBSERVATION_SCHEMA },
    { name: "browser_tabs", description: "List Chrome tabs visible to browserControl. Read-only.", inputSchema: EMPTY_SCHEMA },
    { name: "browser_switch_tab", description: "Switch control to a tab returned by browser_tabs from a fresh observation.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, targetId: { type: "string" } }, required: ["observationId", "targetId"], additionalProperties: false } },
    { name: "browser_new_tab", description: "Create a new tab from a fresh observation.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, url: { type: "string", format: "uri" } }, required: ["observationId"], additionalProperties: false } },
    { name: "browser_close_tab", description: "Close a tab from a fresh observation. If targetId is omitted, close the currently shared tab.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, targetId: { type: "string" } }, required: ["observationId"], additionalProperties: false } },
    { name: "browser_handle_dialog", description: "Accept or dismiss the active JavaScript dialog from a fresh observation.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, accept: { type: "boolean" }, promptText: { type: "string" } }, required: ["observationId", "accept"], additionalProperties: false } },
    { name: "browser_release_control", description: "Release this client's exclusive interactive-control lease.", inputSchema: EMPTY_SCHEMA },
  ];
}

function requestClientId(requestInfo?: Request): string {
  const explicit = requestInfo?.headers.get("x-browsercontrol-client-id")?.trim();
  if (explicit) return `client:${explicit.slice(0, 160)}`;

  const legacySession = requestInfo?.headers.get("mcp-session-id")?.trim();
  if (legacySession) return `legacy-session:${legacySession.slice(0, 160)}`;

  let principal = requestInfo?.headers.get("authorization") || "";
  if (!principal && requestInfo) {
    try { principal = new URL(requestInfo.url).searchParams.get("token") || ""; } catch {}
  }
  const digest = createHash("sha256").update(principal || "anonymous").digest("hex").slice(0, 32);
  return `principal:${digest}`;
}

function createGatewayMcpServer(bridge: ExtensionBridge, lease: ControlLease, clientId: string): Server {
  const server = new Server({ name: "browser-control-remote", version: "0.5.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({ tools: tools() }));

  const mutate = async (method: string, params: Record<string, any>) => {
    if (!lease.acquire(clientId)) {
      const error = new Error("Another AI client currently controls this browser. Try again after its lease expires or is released.");
      (error as any).code = "DEVICE_BUSY";
      throw error;
    }
    return bridge.call(method, params);
  };

  server.setRequestHandler("tools/call", async (request: any) => {
    const args = (request.params?.arguments || {}) as Record<string, any>;
    try {
      switch (request.params?.name) {
        case "browser_status": {
          const extension = bridge.connected ? await bridge.call("status") : { connected: false };
          const currentLease = lease.status();
          return textResult({ extension, lease: { busy: !!currentLease.owner && currentLease.owner !== clientId, expiresAt: currentLease.expiresAt } });
        }
        case "browser_observe": return imageResult(await bridge.call("observe", args));
        case "browser_inspect": return imageResult(await bridge.call("inspect_region", args));
        case "browser_move": return textResult(await mutate("move", args));
        case "browser_click": return textResult(await mutate("click", args));
        case "browser_double_click": return textResult(await mutate("double_click", args));
        case "browser_drag": return textResult(await mutate("drag", args));
        case "browser_scroll": return textResult(await mutate("scroll", args));
        case "browser_type": return textResult(await mutate("type", args));
        case "browser_keypress": return textResult(await mutate("keypress", args));
        case "browser_navigate": return textResult(await mutate("navigate", args));
        case "browser_back": return textResult(await mutate("back", args));
        case "browser_forward": return textResult(await mutate("forward", args));
        case "browser_reload": return textResult(await mutate("reload", args));
        case "browser_tabs": return textResult(await bridge.call("tabs"));
        case "browser_switch_tab": return textResult(await mutate("switch_tab", args));
        case "browser_new_tab": return textResult(await mutate("new_tab", args));
        case "browser_close_tab": return textResult(await mutate("close_tab", args));
        case "browser_handle_dialog": return textResult(await mutate("handle_dialog", args));
        case "browser_release_control":
          lease.release(clientId);
          return textResult({ success: true });
        default:
          throw new Error(`Unknown tool: ${request.params?.name}`);
      }
    } catch (error) {
      return toolError(error);
    }
  });

  return server;
}

export interface RemoteGatewayOptions {
  port?: number;
  host?: string;
  extensionToken?: string;
  mcpBearerToken?: string;
  adminBearerToken?: string;
  deviceRegistry?: DeviceRegistry;
  pairingManager?: PairingManager;
  leaseTtlMs?: number;
  maxMcpBodySize?: number;
  trustProxy?: boolean;
  pairingAttemptsPerMinute?: number;
}

export interface RemoteGatewayHandle {
  httpServer: http.Server;
  wss: WebSocketServer;
  deviceRegistry: DeviceRegistry;
  pairingManager: PairingManager;
  mcpBearerToken: string;
  adminBearerToken: string;
}

export async function runRemoteGateway(options: RemoteGatewayOptions = {}): Promise<RemoteGatewayHandle> {
  const port = options.port ?? Number(process.env.BROWSERCONTROL_GATEWAY_PORT || 8787);
  const host = options.host ?? process.env.BROWSERCONTROL_GATEWAY_HOST ?? "127.0.0.1";
  const loopback = isLoopbackHost(host);
  const extensionToken = options.extensionToken ?? process.env.BROWSERCONTROL_DEVICE_TOKEN ?? "";
  const configuredMcpBearerToken = options.mcpBearerToken ?? process.env.BROWSERCONTROL_MCP_TOKEN ?? "";
  const configuredAdminBearerToken = options.adminBearerToken ?? process.env.BROWSERCONTROL_ADMIN_TOKEN ?? "";
  const trustProxy = options.trustProxy ?? process.env.BROWSERCONTROL_TRUST_PROXY === "1";

  if (!configuredMcpBearerToken && !loopback) {
    throw new Error("BROWSERCONTROL_MCP_TOKEN is required when the gateway is not bound to loopback");
  }
  if (!configuredAdminBearerToken && !loopback) {
    throw new Error("BROWSERCONTROL_ADMIN_TOKEN is required when the gateway is not bound to loopback");
  }
  if (extensionToken && !loopback) {
    throw new Error("BROWSERCONTROL_DEVICE_TOKEN is only supported for loopback development; deployed gateways must use revocable device pairing");
  }

  const mcpBearerToken = configuredMcpBearerToken || randomBytes(32).toString("base64url");
  const adminBearerToken = configuredAdminBearerToken || randomBytes(32).toString("base64url");
  const maxMcpBodySize = options.maxMcpBodySize ?? 2 * 1024 * 1024;
  const bridge = new ExtensionBridge();
  const lease = new ControlLease(options.leaseTtlMs ?? 60_000);
  const deviceRegistry = options.deviceRegistry ?? new DeviceRegistry();
  const pairingManager = options.pairingManager ?? new PairingManager(deviceRegistry);
  const pairingIpLimiter = new FixedWindowRateLimiter(options.pairingAttemptsPerMinute ?? 12, 60_000);
  const pairingGlobalLimiter = new FixedWindowRateLimiter(120, 60_000);
  const mcpLimiter = new FixedWindowRateLimiter(600, 60_000);

  if (!configuredMcpBearerToken) {
    console.warn(`[browserControl] Generated temporary MCP bearer token: ${mcpBearerToken}`);
  }
  if (!configuredAdminBearerToken) {
    console.warn(`[browserControl] Generated temporary admin bearer token: ${adminBearerToken}`);
  }

  const mcpHandler = createMcpHandler(
    ({ requestInfo }) => createGatewayMcpServer(bridge, lease, requestClientId(requestInfo)),
    { legacy: "stateless" }
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => console.error("[browserControl] Remote MCP adapter error:", error),
  });

  const authorizedMcpRequest = (req: http.IncomingMessage, url: URL) => {
    const auth = bearerToken(req);
    const queryToken = url.searchParams.get("token") || "";
    return safeTokenEqual(auth, mcpBearerToken) || safeTokenEqual(queryToken, mcpBearerToken);
  };

  const authorizedAdminRequest = (req: http.IncomingMessage) => safeTokenEqual(bearerToken(req), adminBearerToken);

  const authenticateExtensionRequest = (token: string): { deviceId?: string } | null => {
    if (loopback && extensionToken && safeTokenEqual(token, extensionToken)) return {};
    const device = deviceRegistry.authenticate(token);
    return device ? { deviceId: device.deviceId } : null;
  };

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      writeJson(res, 200, { ok: true, extensionConnected: bridge.connected });
      return;
    }

    if (url.pathname === "/pairing/create" && req.method === "POST") {
      if (!authorizedAdminRequest(req)) {
        writeJson(res, 401, { error: "Unauthorized" });
        req.resume();
        return;
      }
      void readJsonBody(req, maxMcpBodySize)
        .then((body) => {
          const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) || undefined : undefined;
          writeJson(res, 201, pairingManager.create(name));
        })
        .catch((error) => writeJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: error?.message || "Invalid request" }));
      return;
    }

    if (url.pathname === "/pairing/claim" && req.method === "POST") {
      const address = requestAddress(req, trustProxy);
      const perIp = pairingIpLimiter.consume(address);
      const global = pairingGlobalLimiter.consume("global");
      if (!perIp.allowed || !global.allowed) {
        const retryAfterMs = Math.max(perIp.retryAfterMs, global.retryAfterMs);
        writeJson(res, 429, { error: "Too many pairing attempts" }, { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) });
        req.resume();
        return;
      }

      void readJsonBody(req, maxMcpBodySize)
        .then((body) => {
          const code = typeof body.code === "string" ? body.code.trim() : "";
          const codePattern = new RegExp(`^\\d{${pairingManager.digits}}$`);
          if (!codePattern.test(code)) {
            writeJson(res, 400, { error: `Pairing code must be ${pairingManager.digits} digits` });
            return;
          }
          const credential = pairingManager.claim(code);
          if (!credential) {
            writeJson(res, 404, { error: "Pairing code is invalid or expired" });
            return;
          }
          writeJson(res, 200, credential);
        })
        .catch((error) => writeJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: error?.message || "Invalid request" }));
      return;
    }

    if (url.pathname === "/devices" && req.method === "GET") {
      if (!authorizedAdminRequest(req)) {
        writeJson(res, 401, { error: "Unauthorized" });
        return;
      }
      writeJson(res, 200, { devices: deviceRegistry.list() });
      return;
    }

    if (url.pathname.startsWith("/devices/") && req.method === "DELETE") {
      if (!authorizedAdminRequest(req)) {
        writeJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const deviceId = decodeURIComponent(url.pathname.slice("/devices/".length));
      if (!deviceId || !deviceRegistry.revoke(deviceId)) {
        writeJson(res, 404, { error: "Device not found" });
        return;
      }
      writeJson(res, 200, { success: true, deviceId });
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    if (!authorizedMcpRequest(req, url)) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const limit = mcpLimiter.consume(requestAddress(req, trustProxy));
    if (!limit.allowed) {
      writeJson(res, 429, { error: "Too many MCP requests" }, { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) });
      req.resume();
      return;
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxMcpBodySize) {
      writeJson(res, 413, { error: "Payload too large" });
      req.resume();
      return;
    }

    void nodeMcpHandler(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  const socketDeviceIds = new WeakMap<WebSocket, string>();
  const deviceSockets = new Map<string, Set<WebSocket>>();

  const unregisterSocket = (ws: WebSocket) => {
    const deviceId = socketDeviceIds.get(ws);
    if (!deviceId) return;
    const sockets = deviceSockets.get(deviceId);
    sockets?.delete(ws);
    if (sockets?.size === 0) deviceSockets.delete(deviceId);
  };

  const unregisterRevocation = deviceRegistry.onRevoked((deviceId) => {
    const sockets = deviceSockets.get(deviceId);
    if (!sockets) return;
    for (const ws of [...sockets]) {
      try { ws.close(4003, "Device credential revoked"); } catch { ws.terminate(); }
    }
  });

  httpServer.once("close", () => {
    unregisterRevocation();
    void mcpHandler.close();
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/extension") {
      socket.destroy();
      return;
    }
    const auth = authenticateExtensionRequest(url.searchParams.get("token") || "");
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (auth.deviceId) {
        socketDeviceIds.set(ws, auth.deviceId);
        let sockets = deviceSockets.get(auth.deviceId);
        if (!sockets) {
          sockets = new Set();
          deviceSockets.set(auth.deviceId, sockets);
        }
        sockets.add(ws);
        ws.once("close", () => unregisterSocket(ws));
      }
      wss.emit("connection", ws, request);
    });
  });
  wss.on("connection", (ws) => bridge.attach(ws));

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`[browserControl] Remote gateway listening on http://${host}:${actualPort}`);
  console.log(`[browserControl] MCP endpoint: http://${host}:${actualPort}/mcp`);
  console.log(`[browserControl] Extension endpoint: ws://${host}:${actualPort}/extension`);

  return { httpServer, wss, deviceRegistry, pairingManager, mcpBearerToken, adminBearerToken };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRemoteGateway({ host: process.env.BROWSERCONTROL_GATEWAY_HOST || "0.0.0.0" }).catch((error) => {
    console.error("Fatal browserControl gateway error:", error);
    process.exit(1);
  });
}
