#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ChromeController } from "../controller.js";

const httpPort = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : 8765;
const httpHost = process.env.MCP_HTTP_HOST || "127.0.0.1";
const authToken = process.env.MCP_AUTH_TOKEN || "";

const chromePort = process.env.CHROME_DEBUG_PORT ? parseInt(process.env.CHROME_DEBUG_PORT, 10) : 9222;
const chromeHost = process.env.CHROME_DEBUG_HOST || "127.0.0.1";
const browserUrl = process.env.CHROME_BROWSER_URL;
const wsEndpoint = process.env.CHROME_WS_ENDPOINT;
const mode = (process.env.CHROME_CONNECT_MODE as any) || (wsEndpoint ? "ws-endpoint" : browserUrl ? "browser-url" : "auto");

const controller = new ChromeController({
  mode,
  port: chromePort,
  host: chromeHost,
  browserUrl,
  wsEndpoint,
});

function createMcpServer(): Server {
  const server = new Server(
    {
      name: "chrome-computer-use-http",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  async function ensureConnected(): Promise<void> {
    if (!controller.isConnected) {
      await controller.connect();
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "computer.observe",
          description: "Capture a visual viewport screenshot with exact coordinate space dimensions.",
          inputSchema: {
            type: "object",
            properties: {
              format: { type: "string", enum: ["png", "jpeg", "webp"] },
              showCursor: { type: "boolean" },
            },
          },
        },
        {
          name: "computer.action",
          description: "Execute mouse, drag, keypress, typing, or wait actions in coordinate space.",
          inputSchema: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "screenshot",
                  "move",
                  "click",
                  "double_click",
                  "down",
                  "up",
                  "scroll",
                  "drag",
                  "keypress",
                  "key_down",
                  "key_up",
                  "type",
                  "wait",
                ],
              },
              observationId: { type: "string" },
              x: { type: "number" },
              y: { type: "number" },
              button: { type: "string", enum: ["left", "right", "middle", "back", "forward"] },
              modifiers: { type: "array", items: { type: "string" } },
              deltaX: { type: "number" },
              deltaY: { type: "number" },
              path: {
                type: "array",
                items: {
                  type: "object",
                  properties: { x: { type: "number" }, y: { type: "number" } },
                  required: ["x", "y"],
                },
              },
              keys: { type: "array", items: { type: "string" } },
              key: { type: "string" },
              text: { type: "string" },
              method: { type: "string", enum: ["auto", "insert_text", "key_events"] },
              ms: { type: "number" },
            },
            required: ["type"],
          },
        },
        {
          name: "browser.tabs",
          description: "List open tabs in Chrome.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "browser.action",
          description: "Perform browser navigation or tab management.",
          inputSchema: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "navigate",
                  "new_tab",
                  "switch_tab",
                  "close_tab",
                  "back",
                  "forward",
                  "reload",
                  "tabs",
                  "windows",
                  "new_window",
                  "activate_window",
                  "close_window",
                  "dialog_state",
                  "handle_dialog",
                ],
              },
              url: { type: "string" },
              targetId: { type: "string" },
              accept: { type: "boolean" },
              promptText: { type: "string" },
            },
            required: ["type"],
          },
        },
        {
          name: "session.stop",
          description: "Stop session and detach debugger.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      await ensureConnected();
      switch (name) {
        case "computer.observe": {
          const obs = await controller.observe(args as any);
          return {
            content: [
              { type: "image", data: obs.image, mimeType: `image/${(args as any)?.format || "png"}` },
              { type: "text", text: JSON.stringify(obs, null, 2) },
            ],
          };
        }
        case "computer.action": {
          const res = await controller.executeComputerAction(args);
          return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: !res.success };
        }
        case "browser.tabs": {
          const tabs = await controller.getTabs();
          return { content: [{ type: "text", text: JSON.stringify(tabs, null, 2) }] };
        }
        case "browser.action": {
          const res = await controller.executeBrowserAction(args);
          return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: !res.success };
        }
        case "session.stop": {
          await controller.stop();
          return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

const mcpServer = createMcpServer();
await mcpServer.connect(transport);

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (authToken) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${authToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing bearer token" }));
      return;
    }
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", connected: controller.isConnected }));
    return;
  }

  if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
    try {
      await transport.handleRequest(req, res);
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found. MCP endpoint is at /mcp");
});

httpServer.listen(httpPort, httpHost, () => {
  console.log(`Chrome Computer-Use Streamable HTTP MCP Server listening on http://${httpHost}:${httpPort}/mcp`);
});
