import http from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

interface ExtensionRpcResponse {
  id: string;
  ok: boolean;
  result?: any;
  error?: { code?: string; message?: string };
}

class ExtensionBridge {
  private socket: WebSocket | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

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
};

function toolError(error: any) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          errorCode: error?.code || "REMOTE_BROWSER_ERROR",
          message: error?.message || String(error),
        }),
      },
    ],
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

async function createGatewayMcpServer(
  bridge: ExtensionBridge,
  lease: ControlLease,
  clientId: string
): Promise<Server> {
  const server = new Server(
    { name: "browser-control-remote", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "browser_status",
        description: "Check browserControl extension connectivity, shared-tab state, pause state, and exclusive-control lease status.",
        inputSchema: EMPTY_SCHEMA,
      },
      {
        name: "browser_observe",
        description: "Capture the currently shared Chrome tab. All model-facing coordinates use normalized 0-1000 x/y values. Coordinate actions must reference the returned observationId.",
        inputSchema: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["jpeg", "png", "webp"], default: "jpeg" },
            quality: { type: "number", minimum: 1, maximum: 100, default: 82 },
          },
          additionalProperties: false,
        },
      },
      {
        name: "browser_inspect",
        description: "Capture a higher-detail sub-region of an existing observation. The returned region observation has its own normalized 0-1000 coordinate space, and actions planned from it map back to the original viewport.",
        inputSchema: {
          type: "object",
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
        description: "Move/hover the cursor to normalized coordinates from a specific observation.",
        inputSchema: { type: "object", properties: POINT_PROPERTIES, required: ["observationId", "x", "y"], additionalProperties: false },
      },
      {
        name: "browser_click",
        description: "Click at normalized coordinates from a specific observation. Stale observations are rejected instead of clicking the wrong place.",
        inputSchema: {
          type: "object",
          properties: { ...POINT_PROPERTIES, button: { type: "string", enum: ["left", "right", "middle"], default: "left" } },
          required: ["observationId", "x", "y"],
          additionalProperties: false,
        },
      },
      {
        name: "browser_double_click",
        description: "Double-click at normalized coordinates from a specific observation.",
        inputSchema: {
          type: "object",
          properties: { ...POINT_PROPERTIES, button: { type: "string", enum: ["left", "right", "middle"], default: "left" } },
          required: ["observationId", "x", "y"],
          additionalProperties: false,
        },
      },
      {
        name: "browser_drag",
        description: "Drag through a normalized waypoint path planned against one observation.",
        inputSchema: {
          type: "object",
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
          type: "object",
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
        description: "Insert text into the focused element in the shared tab.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      },
      {
        name: "browser_keypress",
        description: "Send a keyboard shortcut such as [\"Meta\",\"A\"] or [\"Control\",\"L\"].",
        inputSchema: { type: "object", properties: { keys: { type: "array", minItems: 1, items: { type: "string" } } }, required: ["keys"], additionalProperties: false },
      },
      {
        name: "browser_navigate",
        description: "Navigate the shared tab to an absolute URL.",
        inputSchema: { type: "object", properties: { url: { type: "string", format: "uri" } }, required: ["url"], additionalProperties: false },
      },
      { name: "browser_back", description: "Navigate the shared tab backward in history.", inputSchema: EMPTY_SCHEMA },
      { name: "browser_forward", description: "Navigate the shared tab forward in history.", inputSchema: EMPTY_SCHEMA },
      { name: "browser_reload", description: "Reload the shared tab.", inputSchema: EMPTY_SCHEMA },
      { name: "browser_tabs", description: "List Chrome tabs visible to browserControl. Read-only.", inputSchema: EMPTY_SCHEMA },
      {
        name: "browser_switch_tab",
        description: "Switch browserControl to a tab returned by browser_tabs.",
        inputSchema: { type: "object", properties: { targetId: { type: "string" } }, required: ["targetId"], additionalProperties: false },
      },
      {
        name: "browser_new_tab",
        description: "Create a new tab and share it for control.",
        inputSchema: { type: "object", properties: { url: { type: "string", format: "uri" } }, additionalProperties: false },
      },
      {
        name: "browser_close_tab",
        description: "Close a tab. If targetId is omitted, closes the currently shared tab.",
        inputSchema: { type: "object", properties: { targetId: { type: "string" } }, additionalProperties: false },
      },
      {
        name: "browser_handle_dialog",
        description: "Accept or dismiss the active JavaScript alert/confirm/prompt dialog.",
        inputSchema: {
          type: "object",
          properties: { accept: { type: "boolean" }, promptText: { type: "string" } },
          required: ["accept"],
          additionalProperties: false,
        },
      },
      { name: "browser_pause", description: "Pause remote browser actions locally. Only status/resume remain available until resumed.", inputSchema: EMPTY_SCHEMA },
      { name: "browser_resume", description: "Resume browserControl after a pause.", inputSchema: EMPTY_SCHEMA },
      { name: "browser_release_control", description: "Release this MCP session's exclusive interactive-control lease.", inputSchema: EMPTY_SCHEMA },
    ],
  }));

  const mutate = async (method: string, params: any) => {
    if (!lease.acquire(clientId)) {
      const error = new Error("Another AI session currently controls this browser. Try again after its lease expires or is released.");
      (error as any).code = "DEVICE_BUSY";
      throw error;
    }
    return bridge.call(method, params);
  };

  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments || {}) as Record<string, any>;
    try {
      switch (request.params.name) {
        case "browser_status": {
          const extension = bridge.connected ? await bridge.call("status") : { connected: false };
          const currentLease = lease.status();
          return text({ extension, lease: { busy: !!currentLease.owner && currentLease.owner !== clientId, expiresAt: currentLease.expiresAt } });
        }
        case "browser_observe": return imageResult(await bridge.call("observe", args));
        case "browser_inspect": return imageResult(await bridge.call("inspect_region", args));
        case "browser_move": return text(await mutate("move", args));
        case "browser_click": return text(await mutate("click", args));
        case "browser_double_click": return text(await mutate("double_click", args));
        case "browser_drag": return text(await mutate("drag", args));
        case "browser_scroll": return text(await mutate("scroll", args));
        case "browser_type": return text(await mutate("type", args));
        case "browser_keypress": return text(await mutate("keypress", args));
        case "browser_navigate": return text(await mutate("navigate", args));
        case "browser_back": return text(await mutate("back", args));
        case "browser_forward": return text(await mutate("forward", args));
        case "browser_reload": return text(await mutate("reload", args));
        case "browser_tabs": return text(await bridge.call("tabs"));
        case "browser_switch_tab": return text(await mutate("switch_tab", args));
        case "browser_new_tab": return text(await mutate("new_tab", args));
        case "browser_close_tab": return text(await mutate("close_tab", args));
        case "browser_handle_dialog": return text(await mutate("handle_dialog", args));
        case "browser_pause": return text(await mutate("pause", args));
        case "browser_resume": return text(await mutate("resume", args));
        case "browser_release_control":
          lease.release(clientId);
          return text({ success: true });
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
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
}

export async function runRemoteGateway(options: RemoteGatewayOptions = {}) {
  const port = options.port ?? Number(process.env.BROWSERCONTROL_GATEWAY_PORT || 8787);
  const host = options.host ?? process.env.BROWSERCONTROL_GATEWAY_HOST ?? "127.0.0.1";
  const extensionToken = options.extensionToken ?? process.env.BROWSERCONTROL_DEVICE_TOKEN ?? "";
  const mcpBearerToken = options.mcpBearerToken ?? process.env.BROWSERCONTROL_MCP_TOKEN ?? "";
  const bridge = new ExtensionBridge();
  const lease = new ControlLease(options.leaseTtlMs ?? 60_000);
  const transports = new Map<string, { transport: StreamableHTTPServerTransport; mcpServer: Server; clientId: string }>();

  const authorizedMcpRequest = (req: http.IncomingMessage, url: URL) => {
    if (!mcpBearerToken) return true;
    const auth = req.headers.authorization || "";
    return auth === `Bearer ${mcpBearerToken}` || url.searchParams.get("token") === mcpBearerToken;
  };

  const httpServer = http.createServer(async (req, res) => {
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

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (req.method === "GET" || req.method === "DELETE") {
      const entry = sessionId ? transports.get(sessionId) : undefined;
      if (!entry) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing MCP session" }));
        return;
      }
      await entry.transport.handleRequest(req, res);
      if (req.method === "DELETE") {
        lease.release(entry.clientId);
        transports.delete(sessionId!);
      }
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let raw = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) {
        tooLarge = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.resume();
      }
    });
    req.on("end", async () => {
      if (tooLarge) return;
      try {
        const body = raw ? JSON.parse(raw) : undefined;
        if (sessionId) {
          const entry = transports.get(sessionId);
          if (!entry) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown MCP session" }));
            return;
          }
          await entry.transport.handleRequest(req, res, body);
          return;
        }
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Expected MCP initialize request" }));
          return;
        }

        const clientId = randomUUID();
        const mcpServer = await createGatewayMcpServer(bridge, lease, clientId);
        let transport!: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, { transport, mcpServer, clientId });
          },
        });
        transport.onclose = () => {
          lease.release(clientId);
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error: any) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error?.message || String(error) }));
        }
      }
    });
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

  return { httpServer, wss, bridge };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRemoteGateway({ host: process.env.BROWSERCONTROL_GATEWAY_HOST || "0.0.0.0" }).catch((error) => {
    console.error("Fatal browserControl gateway error:", error);
    process.exit(1);
  });
}
