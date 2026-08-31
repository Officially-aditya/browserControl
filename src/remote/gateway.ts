import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { DeviceRegistry, PairingManager, type DeviceIdentity } from "./device-auth.js";
import { DeviceRouter } from "./device-router.js";
import { createDeviceMcpServer } from "./browser-tools.js";
import { loadDeviceRegistry, persistDeviceRegistry, type DeviceRegistryPersistence } from "./device-store.js";

const LOCAL_DEVICE_ID = "local-development";
const ROUTED_DEVICE_HEADER = "x-browsercontrol-routed-device";

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

async function readRawBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" });
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        settled = true;
        request.resume();
        reject(Object.assign(new Error("Payload too large"), { code: "PAYLOAD_TOO_LARGE" }));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

async function readJsonBody(request: http.IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const body = await readRawBody(request, maxBytes);
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : "Invalid JSON body"), { code: "INVALID_JSON" });
  }
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

async function writeWebResponse(response: Response, nodeResponse: http.ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  nodeResponse.writeHead(response.status, headers);
  if (!response.body) {
    nodeResponse.end();
    return;
  }
  Readable.fromWeb(response.body as any).pipe(nodeResponse);
}

interface RoutedMcpPrincipal extends DeviceIdentity {
  localDevelopment?: boolean;
}

export interface RemoteGatewayOptions {
  port?: number;
  host?: string;
  extensionToken?: string;
  /** Loopback development only. Public relays use per-device MCP tokens issued by pairing. */
  mcpBearerToken?: string;
  adminBearerToken?: string;
  deviceRegistry?: DeviceRegistry;
  pairingManager?: PairingManager;
  deviceStorePath?: string;
  leaseTtlMs?: number;
  maxMcpBodySize?: number;
  trustProxy?: boolean;
  pairingAttemptsPerMinute?: number;
}

export interface RemoteGatewayHandle {
  httpServer: http.Server;
  wss: WebSocketServer;
  deviceRegistry: DeviceRegistry;
  deviceRouter: DeviceRouter;
  pairingManager: PairingManager;
  /** Loopback development credential. Empty on a public relay. */
  mcpBearerToken: string;
  adminBearerToken: string;
  devicePersistence?: DeviceRegistryPersistence;
}

export async function runRemoteGateway(options: RemoteGatewayOptions = {}): Promise<RemoteGatewayHandle> {
  const port = options.port ?? Number(process.env.BROWSERCONTROL_GATEWAY_PORT || 8787);
  const host = options.host ?? process.env.BROWSERCONTROL_GATEWAY_HOST ?? "127.0.0.1";
  const loopback = isLoopbackHost(host);
  const extensionToken = options.extensionToken ?? process.env.BROWSERCONTROL_DEVICE_TOKEN ?? "";
  const configuredMcpBearerToken = options.mcpBearerToken ?? process.env.BROWSERCONTROL_MCP_TOKEN ?? "";
  const configuredAdminBearerToken = options.adminBearerToken ?? process.env.BROWSERCONTROL_ADMIN_TOKEN ?? "";
  const deviceStorePath = options.deviceStorePath ?? process.env.BROWSERCONTROL_DEVICE_STORE_PATH ?? "";
  const trustProxy = options.trustProxy ?? process.env.BROWSERCONTROL_TRUST_PROXY === "1";

  if (!configuredAdminBearerToken && !loopback) {
    throw new Error("BROWSERCONTROL_ADMIN_TOKEN is required when the gateway is not bound to loopback");
  }
  if (extensionToken && !loopback) {
    throw new Error("BROWSERCONTROL_DEVICE_TOKEN is only supported for loopback development; deployed gateways must use revocable device pairing");
  }
  if (configuredMcpBearerToken && !loopback) {
    throw new Error("BROWSERCONTROL_MCP_TOKEN is only supported for loopback development; deployed gateways use device-scoped MCP credentials from pairing");
  }

  const mcpBearerToken = loopback ? (configuredMcpBearerToken || randomBytes(32).toString("base64url")) : "";
  const adminBearerToken = configuredAdminBearerToken || randomBytes(32).toString("base64url");
  const maxMcpBodySize = options.maxMcpBodySize ?? 2 * 1024 * 1024;
  const deviceRegistry = options.deviceRegistry ?? (deviceStorePath ? await loadDeviceRegistry(deviceStorePath) : new DeviceRegistry());
  const pairingManager = options.pairingManager ?? new PairingManager(deviceRegistry);
  const deviceRouter = new DeviceRouter(options.leaseTtlMs ?? 60_000);
  const devicePersistence = deviceStorePath ? persistDeviceRegistry(deviceRegistry, deviceStorePath) : undefined;
  const pairingIpLimiter = new FixedWindowRateLimiter(options.pairingAttemptsPerMinute ?? 12, 60_000);
  const pairingGlobalLimiter = new FixedWindowRateLimiter(120, 60_000);
  const mcpLimiter = new FixedWindowRateLimiter(600, 60_000);

  if (loopback && !configuredMcpBearerToken) {
    console.warn(`[browserControl] Generated temporary local MCP bearer token: ${mcpBearerToken}`);
  }
  if (!configuredAdminBearerToken) {
    console.warn(`[browserControl] Generated temporary admin bearer token: ${adminBearerToken}`);
  }

  const mcpHandler = createMcpHandler(({ requestInfo }) => {
    const deviceId = requestInfo?.headers.get(ROUTED_DEVICE_HEADER)?.trim();
    if (!deviceId) throw new Error("Missing authenticated browserControl device route");
    return createDeviceMcpServer(deviceRouter.route(deviceId), requestClientId(requestInfo));
  }, { legacy: "stateless" });

  const authorizedAdminRequest = (req: http.IncomingMessage) => safeTokenEqual(bearerToken(req), adminBearerToken);

  const authenticateExtensionRequest = (token: string): DeviceIdentity | null => {
    if (loopback && extensionToken && safeTokenEqual(token, extensionToken)) {
      return { deviceId: LOCAL_DEVICE_ID, name: "Local development" };
    }
    return deviceRegistry.authenticateDevice(token);
  };

  const authenticateMcpRequest = (req: http.IncomingMessage, url: URL): RoutedMcpPrincipal | null => {
    const token = bearerToken(req) || url.searchParams.get("token") || "";
    const device = deviceRegistry.authenticateMcp(token);
    if (device) return device;
    if (loopback && mcpBearerToken && safeTokenEqual(token, mcpBearerToken)) {
      return { deviceId: LOCAL_DEVICE_ID, name: "Local development", localDevelopment: true };
    }
    return null;
  };

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      const connectedDevices = deviceRouter.connectedCount();
      writeJson(res, 200, { ok: true, connectedDevices, extensionConnected: connectedDevices > 0 });
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
      writeJson(res, 200, {
        devices: deviceRegistry.list().map((device) => ({ ...device, connected: deviceRouter.isConnected(device.deviceId) })),
      });
      return;
    }

    const rotateMatch = url.pathname.match(/^\/devices\/([^/]+)\/connector\/rotate$/);
    if (rotateMatch && req.method === "POST") {
      if (!authorizedAdminRequest(req)) {
        writeJson(res, 401, { error: "Unauthorized" });
        req.resume();
        return;
      }
      const deviceId = decodeURIComponent(rotateMatch[1]);
      const rotated = deviceRegistry.rotateMcpToken(deviceId);
      if (!rotated) {
        writeJson(res, 404, { error: "Device not found" });
        return;
      }
      writeJson(res, 200, rotated);
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

    const principal = authenticateMcpRequest(req, url);
    if (!principal) {
      writeJson(res, 401, { error: "Unauthorized" });
      req.resume();
      return;
    }

    const limit = mcpLimiter.consume(`${principal.deviceId}:${requestAddress(req, trustProxy)}`);
    if (!limit.allowed) {
      writeJson(res, 429, { error: "Too many MCP requests" }, { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) });
      req.resume();
      return;
    }

    void readRawBody(req, maxMcpBodySize)
      .then(async (body) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value == null) continue;
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        headers.set(ROUTED_DEVICE_HEADER, principal.deviceId);
        const requestUrl = new URL(req.url || "/mcp", `http://${req.headers.host || "localhost"}`);
        const webRequest = new Request(requestUrl, {
          method: req.method || "POST",
          headers,
          body: body.length ? body.toString("utf8") : undefined,
        });
        const response = await mcpHandler.fetch(webRequest);
        await writeWebResponse(response, res);
      })
      .catch((error) => {
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        writeJson(res, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 500, { error: error?.message || "MCP request failed" });
      });
  });

  const wss = new WebSocketServer({ noServer: true });
  const unregisterRevocation = deviceRegistry.onRevoked((deviceId) => {
    deviceRouter.disconnect(deviceId, 4003, "Device credential revoked");
  });

  httpServer.once("close", () => {
    unregisterRevocation();
    void mcpHandler.close();
    void devicePersistence?.close();
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/extension") {
      socket.destroy();
      return;
    }
    const identity = authenticateExtensionRequest(url.searchParams.get("token") || "");
    if (!identity) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      deviceRouter.attach(identity.deviceId, ws);
      wss.emit("connection", ws, request);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`[browserControl] Routed relay listening on http://${host}:${actualPort}`);
  console.log(`[browserControl] MCP endpoint: http://${host}:${actualPort}/mcp`);
  console.log(`[browserControl] Extension endpoint: ws://${host}:${actualPort}/extension`);

  return {
    httpServer,
    wss,
    deviceRegistry,
    deviceRouter,
    pairingManager,
    mcpBearerToken,
    adminBearerToken,
    devicePersistence,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRemoteGateway({ host: process.env.BROWSERCONTROL_GATEWAY_HOST || "0.0.0.0" }).catch((error) => {
    console.error("Fatal browserControl gateway error:", error);
    process.exit(1);
  });
}
