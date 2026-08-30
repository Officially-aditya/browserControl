import http from "node:http";
import { ChromeController } from "../controller.js";
import { createMcpServer } from "./server.js";

export async function runHttpMcpServer(
  port = Number(process.env.MCP_HTTP_PORT || 8765),
  host = process.env.MCP_HTTP_HOST || "127.0.0.1"
): Promise<http.Server> {
  const authToken = process.env.MCP_AUTH_TOKEN;

  const mode = (process.env.CHROME_CONNECT_MODE as any) || "auto";
  const controller = new ChromeController({
    mode,
    browserUrl: process.env.CHROME_BROWSER_URL,
    wsEndpoint: process.env.CHROME_WS_ENDPOINT,
  });

  try {
    await controller.connect();
  } catch (err: any) {
    console.error(`[MCP-HTTP] Warning: initial connection failed: ${err.message}. Ready for auto-reconnect.`);
  }

  const server = http.createServer(async (req, res) => {
    // 1. CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. Authentication check
    if (authToken) {
      const authHeader = req.headers["authorization"];
      if (!authHeader || authHeader !== `Bearer ${authToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing Bearer token" }));
        return;
      }
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", connected: controller.isConnected }));
      return;
    }

    if (url.pathname === "/doctor") {
      const doc = await controller.doctor();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(doc, null, 2));
      return;
    }

    // MCP JSON-RPC handler endpoint
    if (url.pathname === "/mcp" || url.pathname === "/") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed. Send POST JSON-RPC request." }));
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });

      req.on("end", async () => {
        try {
          const rpc = JSON.parse(body);
          const { method, params, id } = rpc;

          if (method === "tools/list") {
            const listRes = {
              jsonrpc: "2.0",
              id,
              result: {
                tools: [
                  {
                    name: "observe",
                    description: "Capture screenshot observation of the active Chrome viewport and record visual epoch",
                  },
                  {
                    name: "computer_action",
                    description: "Execute visual computer-use action (click, move, drag, scroll, keypress, type, etc.)",
                  },
                  {
                    name: "browser_action",
                    description: "Execute browser chassis navigation, tabs, windows, or dialog operations",
                  },
                  {
                    name: "doctor",
                    description: "Inspect Chrome connection status, visual epoch, viewport metrics, and coordinate scaling",
                  },
                ],
              },
            };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(listRes));
            return;
          }

          if (method === "tools/call") {
            const { name, arguments: args } = params;

            if (name === "observe") {
              const obs = await controller.observe(args);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          observationId: obs.observationId,
                          visualEpoch: obs.visualEpoch,
                          viewportWidth: obs.viewportWidth,
                          viewportHeight: obs.viewportHeight,
                          imageWidth: obs.imageWidth,
                          imageHeight: obs.imageHeight,
                          scaleX: obs.coordinateSpace.scaleX,
                          scaleY: obs.coordinateSpace.scaleY,
                          url: obs.url,
                          title: obs.title,
                          cursorPosition: obs.cursorPosition,
                          activeDialog: obs.activeDialog,
                        }),
                      },
                      { type: "image", data: obs.image, mimeType: "image/png" },
                    ],
                  },
                })
              );
              return;
            }

            if (name === "computer_action") {
              const actionResult = await controller.executeComputerAction(args);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [{ type: "text", text: JSON.stringify(actionResult, null, 2) }],
                    isError: !actionResult.success,
                  },
                })
              );
              return;
            }

            if (name === "browser_action") {
              const actionResult = await controller.executeBrowserAction(args);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [{ type: "text", text: JSON.stringify(actionResult, null, 2) }],
                    isError: !actionResult.success,
                  },
                })
              );
              return;
            }

            if (name === "doctor") {
              const diagnostic = await controller.doctor();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [{ type: "text", text: JSON.stringify(diagnostic, null, 2) }],
                  },
                })
              );
              return;
            }
          }

          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Internal error: ${err.message}` }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, host, () => {
    console.log(`[MCP-HTTP] Streamable HTTP server listening on http://${host}:${port}/mcp`);
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHttpMcpServer().catch((err) => {
    console.error("Fatal MCP HTTP server error:", err);
    process.exit(1);
  });
}
