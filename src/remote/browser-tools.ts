import { Server, type Tool } from "@modelcontextprotocol/server";
import type { DeviceRoute } from "./device-router.js";

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

export function browserTools(): Tool[] {
  return [
    { name: "browser_status", description: "Check this routed browserControl device, shared-tab state, local pause state, and exclusive-control lease status.", inputSchema: EMPTY_SCHEMA },
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
    { name: "browser_move", description: "Move/hover at normalized coordinates from a specific observation.", inputSchema: { type: "object" as const, properties: POINT_PROPERTIES, required: ["observationId", "x", "y"], additionalProperties: false } },
    { name: "browser_click", description: "Click at normalized coordinates from a specific observation. Stale observations are rejected.", inputSchema: { type: "object" as const, properties: { ...POINT_PROPERTIES, button: { type: "string", enum: ["left", "right", "middle"], default: "left" } }, required: ["observationId", "x", "y"], additionalProperties: false } },
    { name: "browser_double_click", description: "Double-click at normalized coordinates from a specific observation.", inputSchema: { type: "object" as const, properties: { ...POINT_PROPERTIES, button: { type: "string", enum: ["left", "right", "middle"], default: "left" } }, required: ["observationId", "x", "y"], additionalProperties: false } },
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
    { name: "browser_type", description: "Insert text into the focused element only if the referenced observation is still current.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, text: { type: "string" } }, required: ["observationId", "text"], additionalProperties: false } },
    { name: "browser_keypress", description: "Send a keyboard shortcut only if the referenced observation is still current.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, keys: { type: "array", minItems: 1, items: { type: "string" } } }, required: ["observationId", "keys"], additionalProperties: false } },
    { name: "browser_navigate", description: "Navigate the currently shared tab to an absolute URL from a fresh observation.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, url: { type: "string", format: "uri" } }, required: ["observationId", "url"], additionalProperties: false } },
    { name: "browser_back", description: "Navigate backward from a fresh observation.", inputSchema: OBSERVATION_SCHEMA },
    { name: "browser_forward", description: "Navigate forward from a fresh observation.", inputSchema: OBSERVATION_SCHEMA },
    { name: "browser_reload", description: "Reload the shared tab from a fresh observation.", inputSchema: OBSERVATION_SCHEMA },
    { name: "browser_tabs", description: "List Chrome tabs visible to this routed browserControl device. Read-only.", inputSchema: EMPTY_SCHEMA },
    { name: "browser_switch_tab", description: "Switch control to a tab returned by browser_tabs from a fresh observation.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, targetId: { type: "string" } }, required: ["observationId", "targetId"], additionalProperties: false } },
    { name: "browser_new_tab", description: "Create a new tab from a fresh observation.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, url: { type: "string", format: "uri" } }, required: ["observationId"], additionalProperties: false } },
    { name: "browser_close_tab", description: "Close a tab from a fresh observation. If targetId is omitted, close the currently shared tab.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, targetId: { type: "string" } }, required: ["observationId"], additionalProperties: false } },
    { name: "browser_handle_dialog", description: "Accept or dismiss the active JavaScript dialog from a fresh observation.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, accept: { type: "boolean" }, promptText: { type: "string" } }, required: ["observationId", "accept"], additionalProperties: false } },
    { name: "browser_release_control", description: "Release this MCP client's exclusive interactive-control lease for the routed device.", inputSchema: EMPTY_SCHEMA },
  ];
}

export function createDeviceMcpServer(route: DeviceRoute, clientId: string): Server {
  const server = new Server({ name: "browser-control-remote", version: "0.6.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({ tools: browserTools() }));

  const mutate = async (method: string, params: Record<string, any>) => {
    if (!route.lease.acquire(clientId)) {
      throw Object.assign(new Error("Another AI client currently controls this browser. Try again after its lease expires or is released."), { code: "DEVICE_BUSY" });
    }
    return route.bridge.call(method, params);
  };

  server.setRequestHandler("tools/call", async (request: any) => {
    const args = (request.params?.arguments || {}) as Record<string, any>;
    try {
      switch (request.params?.name) {
        case "browser_status": {
          const extension = route.bridge.connected ? await route.bridge.call("status") : { connected: false };
          const currentLease = route.lease.status();
          return textResult({
            deviceId: route.deviceId,
            extension,
            lease: { busy: !!currentLease.owner && currentLease.owner !== clientId, expiresAt: currentLease.expiresAt },
          });
        }
        case "browser_observe": return imageResult(await route.bridge.call("observe", args));
        case "browser_inspect": return imageResult(await route.bridge.call("inspect_region", args));
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
        case "browser_tabs": return textResult(await route.bridge.call("tabs"));
        case "browser_switch_tab": return textResult(await mutate("switch_tab", args));
        case "browser_new_tab": return textResult(await mutate("new_tab", args));
        case "browser_close_tab": return textResult(await mutate("close_tab", args));
        case "browser_handle_dialog": return textResult(await mutate("handle_dialog", args));
        case "browser_release_control":
          route.lease.release(clientId);
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
