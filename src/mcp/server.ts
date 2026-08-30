import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ChromeController } from "../controller.js";

export async function createMcpServer(controller: ChromeController): Promise<Server> {
  const server = new Server(
    {
      name: "chrome-computer-use",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "observe",
          description: "Capture screenshot observation of the active Chrome viewport and record visual epoch",
          inputSchema: {
            type: "object",
            properties: {
              format: { type: "string", enum: ["png", "jpeg", "webp"], default: "png" },
              quality: { type: "number", minimum: 1, maximum: 100, default: 85 },
              showCursor: { type: "boolean", default: false },
            },
          },
        },
        {
          name: "computer_action",
          description: "Execute a visual computer-use action (click, move, double_click, down, up, scroll, drag, keypress, key_down, key_up, type, reset_input, wait) on Chrome",
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
                  "reset_input",
                  "wait",
                ],
              },
              observationId: {
                type: "string",
                description: "The observationId from the screenshot this action was planned against (required for coordinate actions)",
              },
              x: { type: "number", description: "X coordinate in screenshot pixel space" },
              y: { type: "number", description: "Y coordinate in screenshot pixel space" },
              button: { type: "string", enum: ["left", "right", "middle", "back", "forward"], default: "left" },
              deltaX: { type: "number", default: 0 },
              deltaY: { type: "number", default: 0 },
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
              method: { type: "string", enum: ["auto", "insert_text", "key_events"], default: "auto" },
              modifiers: { type: "array", items: { type: "string" } },
              ms: { type: "number" },
            },
            required: ["type"],
          },
        },
        {
          name: "browser_action",
          description: "Execute browser chassis navigation, tabs, windows, or dialog operations",
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
              windowId: { type: "number" },
              accept: { type: "boolean" },
              promptText: { type: "string" },
            },
            required: ["type"],
          },
        },
        {
          name: "doctor",
          description: "Inspect Chrome connection status, visual epoch, viewport metrics, and coordinate scaling",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    };
  });

  let connectingPromise: Promise<void> | null = null;

  async function ensureControllerConnected(): Promise<void> {
    if (controller.isConnected && controller.session.sessionId) {
      return;
    }
    if (!connectingPromise) {
      connectingPromise = (async () => {
        try {
          await controller.connect();
        } finally {
          connectingPromise = null;
        }
      })();
    }
    return connectingPromise;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "doctor") {
      try {
        await ensureControllerConnected();
      } catch {}
      const diagnostic = await controller.doctor();
      return {
        content: [{ type: "text", text: JSON.stringify(diagnostic, null, 2) }],
      };
    }

    try {
      await ensureControllerConnected();
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: false,
                errorCode: "CONNECTION_FAILED",
                message: `Failed to connect to Chrome: ${err.message}. Ensure Chrome is running with remote debugging enabled.`,
                troubleshooting: [
                  "1. If Chrome is running, open chrome://inspect/#remote-debugging in Chrome and ensure remote debugging is enabled.",
                  "2. Or launch Chrome with: --remote-debugging-port=9222",
                  "3. Or pass explicit endpoint with CHROME_BROWSER_URL=http://127.0.0.1:9222 or CHROME_WS_ENDPOINT=ws://...",
                ],
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    if (name === "observe") {
      const obs = await controller.observe(args as any);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
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
              },
              null,
              2
            ),
          },
          {
            type: "image",
            data: obs.image,
            mimeType: (args as any)?.format === "jpeg" ? "image/jpeg" : (args as any)?.format === "webp" ? "image/webp" : "image/png",
          },
        ],
      };
    }

    if (name === "computer_action") {
      const result = await controller.executeComputerAction(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.success,
      };
    }

    if (name === "browser_action") {
      const result = await controller.executeBrowserAction(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.success,
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

export async function runStdioServer(): Promise<void> {
  const mode = (process.env.CHROME_CONNECT_MODE as any) || "auto";
  const controller = new ChromeController({
    mode,
    browserUrl: process.env.CHROME_BROWSER_URL,
    wsEndpoint: process.env.CHROME_WS_ENDPOINT,
  });

  try {
    await controller.connect();
  } catch (err: any) {
    console.error(`[MCP] Warning: initial connection failed: ${err.message}. Ready for auto-reconnect.`);
  }

  const server = await createMcpServer(controller);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStdioServer().catch((err) => {
    console.error("Fatal MCP error:", err);
    process.exit(1);
  });
}
