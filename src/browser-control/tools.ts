import { Server, type Tool } from "@modelcontextprotocol/server";
import { assertSafeNavigationUrl, assertSafeNewTabUrl } from "../browser/safe-url.js";
import type { BrowserRoute } from "./bridge.js";

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;
const OBSERVATION_SCHEMA = {
  type: "object" as const,
  properties: { observationId: { type: "string" } },
  required: ["observationId"],
  additionalProperties: false,
};
const OPTIONAL_OBSERVATION_SCHEMA = {
  type: "object" as const,
  properties: { observationId: { type: "string" } },
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
        errorCode: error?.code || "BROWSERCONTROL_ERROR",
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
    { name: "browser_status", description: "Check this browserControl device, active-tab/bootstrap state, shared-tab state, latest freshness invalidation reason, local pause state, and exclusive-control lease status.", inputSchema: EMPTY_SCHEMA },
    {
      name: "browser_observe",
      description: "Capture the currently shared Chrome tab. Coordinates use normalized 0-1000 values. Visual/focus-dependent actions such as click, type, drag, and scroll must reference the returned observationId.",
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
            maxItems: 50,
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
      description: "Scroll at normalized coordinates using CSS-pixel wheel deltas from a fresh observation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          observationId: { type: "string" },
          x: { type: "number", minimum: 0, maximum: 1000, default: 500 },
          y: { type: "number", minimum: 0, maximum: 1000, default: 500 },
          deltaX: { type: "number", minimum: -4000, maximum: 4000, default: 0 },
          deltaY: { type: "number", minimum: -4000, maximum: 4000 },
        },
        required: ["observationId", "deltaY"],
        additionalProperties: false,
      },
    },
    { name: "browser_type", description: "Insert text into the focused element only if the referenced observation is still current.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, text: { type: "string", maxLength: 5000 } }, required: ["observationId", "text"], additionalProperties: false } },
    { name: "browser_keypress", description: "Send a keyboard shortcut only if the referenced observation is still current.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, keys: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 50 } } }, required: ["observationId", "keys"], additionalProperties: false } },
    { name: "browser_navigate", description: "Navigate the shared tab to an http(s) URL. This deterministic recovery action does not require a fresh observation, including on dynamic pages and Chrome New Tab/about:blank.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, url: { type: "string", format: "uri", maxLength: 2048 } }, required: ["url"], additionalProperties: false } },
    { name: "browser_back", description: "Navigate the shared tab backward. A stale or omitted observation does not block this deterministic recovery action.", inputSchema: OPTIONAL_OBSERVATION_SCHEMA },
    { name: "browser_forward", description: "Navigate the shared tab forward. A stale or omitted observation does not block this deterministic recovery action.", inputSchema: OPTIONAL_OBSERVATION_SCHEMA },
    { name: "browser_reload", description: "Reload the shared tab. A stale or omitted observation does not block this deterministic recovery action.", inputSchema: OPTIONAL_OBSERVATION_SCHEMA },
    { name: "browser_tabs", description: "List Chrome tabs visible to this browserControl device. Read-only.", inputSchema: EMPTY_SCHEMA },
    { name: "browser_switch_tab", description: "Switch control to an explicit targetId returned by browser_tabs. No observation is required because the target tab is explicit.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, targetId: { type: "string", maxLength: 128 } }, required: ["targetId"], additionalProperties: false } },
    { name: "browser_new_tab", description: "Create a new tab. No observation is required. Only http://, https://, or about:blank are allowed.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, url: { type: "string", format: "uri", maxLength: 2048 } }, additionalProperties: false } },
    { name: "browser_close_tab", description: "Close a tab from a fresh observation. If targetId is omitted, close the currently shared tab.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, targetId: { type: "string", maxLength: 128 } }, required: ["observationId"], additionalProperties: false } },
    { name: "browser_handle_dialog", description: "Accept or dismiss the active JavaScript dialog from a fresh observation.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, accept: { type: "boolean" }, promptText: { type: "string", maxLength: 5000 } }, required: ["observationId", "accept"], additionalProperties: false } },
    { name: "browser_release_control", description: "Release this MCP client's exclusive interactive-control lease for the browserControl device.", inputSchema: EMPTY_SCHEMA },
  ];
}

function assertAllowedCall(method: string, args: Record<string, any>): Record<string, any> {
  const next = { ...args };
  if (method === "navigate") {
    if (typeof next.url !== "string") throw Object.assign(new Error("url is required"), { code: "UNSAFE_NAVIGATION_URL" });
    next.url = assertSafeNavigationUrl(next.url);
  } else if (method === "new_tab") {
    next.url = assertSafeNewTabUrl(typeof next.url === "string" ? next.url : undefined);
  } else if (method === "type") {
    if (typeof next.text === "string" && next.text.length > 5000) {
      throw Object.assign(new Error("type text must be at most 5000 characters"), { code: "INPUT_TOO_LARGE" });
    }
  } else if (method === "keypress") {
    if (Array.isArray(next.keys)) {
      if (next.keys.length > 10) throw Object.assign(new Error("keys must have at most 10 entries"), { code: "INPUT_TOO_LARGE" });
      for (const key of next.keys) {
        if (typeof key !== "string" || key.length > 50) {
          throw Object.assign(new Error("each key must be at most 50 characters"), { code: "INPUT_TOO_LARGE" });
        }
      }
    }
  } else if (method === "drag") {
    if (Array.isArray(next.path) && next.path.length > 50) {
      throw Object.assign(new Error("drag path must have at most 50 points"), { code: "INPUT_TOO_LARGE" });
    }
  } else if (method === "scroll") {
    for (const field of ["deltaX", "deltaY"] as const) {
      const value = next[field] ?? 0;
      if (typeof value === "number" && Math.abs(value) > 4000) {
        throw Object.assign(new Error(`${field} must be within ±4000`), { code: "INPUT_TOO_LARGE" });
      }
    }
  } else if (method === "handle_dialog") {
    if (typeof next.promptText === "string" && next.promptText.length > 5000) {
      throw Object.assign(new Error("promptText must be at most 5000 characters"), { code: "INPUT_TOO_LARGE" });
    }
  }
  return next;
}

export async function handleBrowserToolCall(
  route: BrowserRoute,
  clientId: string,
  toolName: string,
  args: Record<string, any> = {},
) {
  const mutate = async (method: string, params: Record<string, any>) => {
    const safeParams = assertAllowedCall(method, params);
    if (!route.lease.acquire(clientId)) {
      throw Object.assign(new Error("Another AI client currently controls this browser. Try again after its lease expires or is released."), { code: "DEVICE_BUSY" });
    }
    return route.bridge.call(method, safeParams);
  };

  try {
    switch (toolName) {
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
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    return toolError(error);
  }
}

export function createBrowserControlMcpServer(
  route: BrowserRoute,
  clientId: string,
  options: { name?: string; version?: string } = {},
): Server {
  const server = new Server(
    { name: options.name || "browser-control", version: options.version || "0.7.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: browserTools() }));
  server.setRequestHandler("tools/call", async (request: any) => {
    const args = (request.params?.arguments || {}) as Record<string, any>;
    return handleBrowserToolCall(route, clientId, request.params?.name, args);
  });
  return server;
}
