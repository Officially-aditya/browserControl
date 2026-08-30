#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ChromeController } from "../controller.js";

const port = process.env.CHROME_DEBUG_PORT ? parseInt(process.env.CHROME_DEBUG_PORT, 10) : 9222;
const host = process.env.CHROME_DEBUG_HOST || "127.0.0.1";
const browserUrl = process.env.CHROME_BROWSER_URL;
const wsEndpoint = process.env.CHROME_WS_ENDPOINT;
const mode = (process.env.CHROME_CONNECT_MODE as any) || (wsEndpoint ? "ws-endpoint" : browserUrl ? "browser-url" : "auto");

const controller = new ChromeController({
  mode,
  port,
  host,
  browserUrl,
  wsEndpoint,
});

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

let isConnected = false;

async function ensureConnected(): Promise<void> {
  if (!isConnected || !controller.isConnected) {
    await controller.connect();
    isConnected = true;
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "computer.observe",
        description:
          "Capture a visual viewport screenshot of the current Chrome tab with exact coordinate-space dimensions. Returns a base64 image and observation metadata including observationId.",
        inputSchema: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["png", "jpeg", "webp"],
              description: "Screenshot image format (default: png)",
            },
            showCursor: {
              type: "boolean",
              description: "Include virtual cursor position marker on observation",
            },
          },
        },
      },
      {
        name: "computer.action",
        description:
          "Execute a computer-use input action (move, click, double_click, down, up, scroll, drag, keypress, key_down, key_up, type, wait) against the browser viewport using screenshot/image coordinates.",
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
              description: "The type of input action to perform",
            },
            observationId: {
              type: "string",
              description: "The observationId of the screenshot this action was planned against (prevents stale coordinate actions)",
            },
            x: { type: "number", description: "X coordinate in screenshot pixel space" },
            y: { type: "number", description: "Y coordinate in screenshot pixel space" },
            button: {
              type: "string",
              enum: ["left", "right", "middle", "back", "forward"],
              description: "Mouse button for clicks (default: left)",
            },
            modifiers: {
              type: "array",
              items: { type: "string" },
              description: "Modifier keys active during mouse action (e.g. ['Meta'], ['Shift'], ['Control'], ['Alt'])",
            },
            deltaX: { type: "number", description: "Horizontal scroll offset in pixels" },
            deltaY: { type: "number", description: "Vertical scroll offset in pixels" },
            path: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                },
                required: ["x", "y"],
              },
              description: "Sequence of coordinates for drag action",
            },
            keys: {
              type: "array",
              items: { type: "string" },
              description: "Array of keys for keypress/shortcuts (e.g. ['Meta', 'A'], ['Enter'], ['Shift', 'Tab'])",
            },
            key: {
              type: "string",
              description: "Single key for key_down or key_up actions (e.g. 'Shift', 'Meta')",
            },
            text: {
              type: "string",
              description: "Text to type into the focused input element",
            },
            method: {
              type: "string",
              enum: ["auto", "insert_text", "key_events"],
              description: "Typing strategy: 'insert_text' for DOM inputs, 'key_events' for canvas/custom inputs (default: auto)",
            },
            ms: {
              type: "number",
              description: "Milliseconds to wait",
            },
          },
          required: ["type"],
        },
      },
      {
        name: "browser.tabs",
        description: "List all open page tabs in the connected Chrome browser session.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "browser.action",
        description:
          "Perform browser-level chassis actions: navigate, new_tab, switch_tab, close_tab, back, forward, reload, windows, new_window, dialog_state, handle_dialog.",
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
            url: { type: "string", description: "URL to navigate or open" },
            targetId: { type: "string", description: "Target ID for switch_tab, close_tab, or window actions" },
            accept: { type: "boolean", description: "Accept (true) or dismiss (false) JavaScript dialog" },
            promptText: { type: "string", description: "Prompt input text for prompt dialog" },
          },
          required: ["type"],
        },
      },
      {
        name: "session.stop",
        description: "Stop the active automation session and detach the CDP debugger from Chrome.",
        inputSchema: {
          type: "object",
          properties: {},
        },
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
        const observation = await controller.observe(args as any);
        return {
          content: [
            {
              type: "image",
              data: observation.image,
              mimeType: `image/${(args as any)?.format || "png"}`,
            },
            {
              type: "text",
              text: JSON.stringify(
                {
                  observationId: observation.observationId,
                  imageWidth: observation.imageWidth,
                  imageHeight: observation.imageHeight,
                  viewportWidth: observation.viewportWidth,
                  viewportHeight: observation.viewportHeight,
                  targetId: observation.targetId,
                  url: observation.url,
                  title: observation.title,
                  coordinateSpace: observation.coordinateSpace,
                  cursorPosition: observation.cursorPosition,
                  activeDialog: observation.activeDialog,
                  timestamp: observation.timestamp,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "computer.action": {
        const result = await controller.executeComputerAction(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: !result.success,
        };
      }

      case "browser.tabs": {
        const tabs = await controller.getTabs();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(tabs, null, 2),
            },
          ],
        };
      }

      case "browser.action": {
        const result = await controller.executeBrowserAction(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: !result.success,
        };
      }

      case "session.stop": {
        await controller.stop();
        isConnected = false;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, message: "Session stopped and detached." }),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error executing tool ${name}: ${err.message}`,
        },
      ],
      isError: true,
    };
  }
});

async function run(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Chrome Computer-Use MCP Server running on stdio");
}

run().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
