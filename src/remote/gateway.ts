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
      if (message.ok) {
        pending.resolve(message.result);
      } else {
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

async function createGatewayMcpServer(
  bridge: ExtensionBridge,
  lease: ControlLease,
  clientId: string
): Promise<Server> {
  const server = new Server(
    { name: "browser-control-remote", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "browser_status",
        description: "Check whether the user's browserControl Chrome extension is connected and whether another client holds the control lease.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "browser_observe",
        description: "Capture the currently shared Chrome tab. Coordinates for subsequent actions use normalized 0-1000 x/y values and must reference the returned observationId.",
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
        name: "browser_click",
        description: "Click the shared Chrome tab at normalized screenshot coordinates. Requires the observationId the click was planned from; stale observations are rejected instead of clicking the wrong place.",
        inputSchema: {
          type: "object",
          properties: {
            observationId: { type: "string" },
            x: { type: "number", minimum: 0, maximum: 1000 },
            y: { type: "number", minimum: 0, maximum: 1000 },
            button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
          },
          required: ["observationId", "x", "y"],
          additionalProperties: false,
        },
      },
      {
        name: "browser_scroll",
        description: "Scroll the shared Chrome tab at normalized coordinates using CSS-pixel wheel deltas.",
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
        description: "Insert text into the currently focused element of the shared tab.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
      {
        name: "browser_keypress",
        description: "Send a keyboard shortcut such as [\"Meta\",\"A\"] or [\"Control\",\"L\"].",
        inputSchema: {
          type: "object",
          properties: { keys: { type: "array", minItems: 1, items: { type: "string" } } },
          required: ["keys"],
          additionalProperties: false,
        },
      },
      {
        name: "browser_navigate",
        description: "Navigate the currently shared tab to an absolute URL.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string", format: "uri" } },
          required: ["url"],
          additionalProperties: false,
        },
      },
      {
        name: "browser_tabs",
        description: "List Chrome tabs visible to the browserControl extension. This is read-only.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "browser_switch_tab",
        description: "Switch browserControl to another tab returned by browser_tabs. This changes which tab is shared for control.",
        inputSchema: {
          type: "object",
          properties: { targetId: { type: "string" } },
          required: ["targetId"],
          additionalProperties: false,
        },
      },
      {
        name: "browser_release_control",
        description: "Release this MCP session's exclusive interactive-control lease.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments || {}) as Record<string, any>;
    try {
      switch (request.params.name) {
        case "browser_status": {
          const extension = bridge.connected ? await bridge.call("status") : { connected: false };
          const currentLease = lease.status();
          return {
            content: [{ type: "text", text: JSON.stringify({ extension, lease: { busy: !!currentLease.owner && currentLease.owner !== clientId, expiresAt: currentLease.expiresAt } }) }],
          };
        }
        case "browser_observe": {
          const observation = await bridge.call("observe", args);
          const { image, mimeType, ...metadata } = observation;
          return {
            content: [
              { type: "text", text: JSON.stringify(metadata, null, 2) },
              { type: "image", data: image, mimeType },
            ],
          };
        }
        case "browser_click":
          return { content: [{ type: "text", text: JSON.stringify(await mutate("click", args)) }] };
        case "browser_scroll":
          return { content: [{ type: "text", text: JSON.stringify(await mutate("scroll", args)) }] };
        case "browser_type":
          return { content: [{ type: "text", text: JSON.stringify(await mutate("type", args)) }] };
        case "browser_keypress":
          return { content: [{ type: "text", text: JSON.stringify(await mutate("keypress", args)) }] };
        case "browser_navigate":
          return { content: [{ type: "text", text: JSON.stringify(await mutate("navigate", args)) }] };
        case "browser_tabs":
          return { content: [{ type: "text", text: JSON.stringify(await bridge.call("tabs"), null, 2) }] };
        case "browser_switch_tab":
          return { content: [{ type: "text", text: JSON.stringify(await mutate("switch_tab", args)) }] };
        case "browser_release_control":
          lease.release(clientId);
          return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
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

    if (mcpBearerToken) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${mcpBearerToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
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
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on("end", async () => {
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
        const mcpServer = await createGatewayMcpServer(bridge, lease, clientId);
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

  console.log(`[browserControl] Remote gateway listening on http://${host}:${port}`);
  console.log(`[browserControl] MCP endpoint: http://${host}:${port}/mcp`);
  console.log(`[browserControl] Extension endpoint: ws://${host}:${port}/extension`);

  return { httpServer, wss, bridge };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRemoteGateway({ host: process.env.BROWSERCONTROL_GATEWAY_HOST || "0.0.0.0" }).catch((error) => {
    console.error("Fatal browserControl gateway error:", error);
    process.exit(1);
  });
}
