import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

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

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;
const POINT_PROPERTIES = {
  observationId: { type: "string" },
  x: { type: "number", minimum: 0, maximum: 1000 },
  y: { type: "number", minimum: 0, maximum: 1000 },
} as const;

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    readonly type: "object";
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
  };
};

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

function tools(): ToolDefinition[] {
  return [
    {
      name: "browser_status",
      description: "Check browserControl connectivity, shared-tab state, local pause state, and exclusive-control lease status.",
      inputSchema: EMPTY_SCHEMA,
    },
    {
      name: "browser_observe",
      description: "Capture the currently shared Chrome tab. Coordinates use normalized 0-1000 values and coordinate actions must reference the returned observationId.",
      inputSchema: {
        type: "object" as const,
        properties: {
          format: { type: "string", enum: ["jpeg", "png", "webp"], default: "jpeg" },
          quality: { type: "number", minimum: 1, maximum: 100, default: 82 },
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
    { name: "browser_type", description: "Insert text into the focused element in the shared tab.", inputSchema: { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
    { name: "browser_keypress", description: "Send a keyboard shortcut.", inputSchema: { type: "object" as const, properties: { keys: { type: "array", minItems: 1, items: { type: "string" } } }, required: ["keys"], additionalProperties: false } },
    { name: "browser_navigate", description: "Navigate the shared tab to an absolute URL.", inputSchema: { type: "object" as const, properties: { url: { type: "string", format: "uri" } }, required: ["url"], additionalProperties: false } },
    { name: "browser_back", description: "Navigate backward in history.", inputSchema: EMPTY_SCHEMA },
    { name: "browser_forward", description: "Navigate forward in history.", inputSchema: EMPTY_SCHEMA },
    { name: "browser_reload", description: "Reload the shared tab.", inputSchema: EMPTY_SCHEMA },
    { name: "browser_tabs", description: "List Chrome tabs visible to browserControl. Read-only.", inputSchema: EMPTY_SCHEMA },
    { name: "browser_switch_tab", description: "Switch control to a tab returned by browser_tabs.", inputSchema: { type: "object" as const, properties: { targetId: { type: "string" } }, required: ["targetId"], additionalProperties: false } },
    { name: "browser_new_tab", description: "Create a new tab and share it for control.", inputSchema: { type: "object" as const, properties: { url: { type: "string", format: "uri" } }, additionalProperties: false } },
    { name: "browser_close_tab", description: "Close a tab. If targetId is omitted, close the currently shared tab.", inputSchema: { type: "object" as const, properties: { targetId: { type: "string" } }, additionalProperties: false } },
    { name: "browser_handle_dialog", description: "Accept or dismiss the active JavaScript dialog.", inputSchema: { type: "object" as const, properties: { accept: { type: "boolean" }, promptText: { type: "string" } }, required: ["accept"], additionalProperties: false } },
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
  const server = new Server({ name: "browser-control-remote", version: "0.4.0" }, { capabilities: { tools: {} } });
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
  leaseTtlMs?: number;
  maxMcpBodySize?: number;
}

export interface RemoteGatewayHandle {
  httpServer: http.Server;
  wss: WebSocketServer;
}

export async function runRemoteGateway(options: RemoteGatewayOptions = {}): Promise<RemoteGatewayHandle> {
  const port = options.port ?? Number(process.env.BROWSERCONTROL_GATEWAY_PORT || 8787);
  const host = options.host ?? process.env.BROWSERCONTROL_GATEWAY_HOST ?? "127.0.0.1";
  const extensionToken = options.extensionToken ?? process.env.BROWSERCONTROL_DEVICE_TOKEN ?? "";
  const mcpBearerToken = options.mcpBearerToken ?? process.env.BROWSERCONTROL_MCP_TOKEN ?? "";
  const maxMcpBodySize = options.maxMcpBodySize ?? 2 * 1024 * 1024;
  const bridge = new ExtensionBridge();
  const lease = new ControlLease(options.leaseTtlMs ?? 60_000);

  const mcpHandler = createMcpHandler(
    ({ requestInfo }) => createGatewayMcpServer(bridge, lease, requestClientId(requestInfo)),
    { legacy: "stateless" }
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => console.error("[browserControl] Remote MCP adapter error:", error),
  });

  const authorizedMcpRequest = (req: http.IncomingMessage, url: URL) => {
    if (!mcpBearerToken) return true;
    const auth = req.headers.authorization || "";
    return auth === `Bearer ${mcpBearerToken}` || url.searchParams.get("token") === mcpBearerToken;
  };

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, extensionConnected: bridge.connected }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }

    if (!authorizedMcpRequest(req, url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxMcpBodySize) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload too large" }));
      req.resume();
      return;
    }

    void nodeMcpHandler(req, res);
  });

  httpServer.once("close", () => {
    void mcpHandler.close();
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/extension") {
      socket.destroy();
      return;
    }
    if (extensionToken && url.searchParams.get("token") !== extensionToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
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

  return { httpServer, wss };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRemoteGateway({ host: process.env.BROWSERCONTROL_GATEWAY_HOST || "0.0.0.0" }).catch((error) => {
    console.error("Fatal browserControl gateway error:", error);
    process.exit(1);
  });
}
