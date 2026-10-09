import { Server, type Tool } from "@modelcontextprotocol/server";
import { assertSafeNavigationUrl, assertSafeNewTabUrl } from "../browser/safe-url.js";
import type { BrowserRoute } from "./bridge.js";
import { actionQueueTimeoutMs } from "./action-queue.js";

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;
const QUEUE_ACTION_TYPES = ["click", "double_click", "move", "type", "keypress", "scroll", "wait"];
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
    { name: "browser_status", description: "Check this browserControl device, active-tab/bootstrap state, logical browser pointer position/source, latest freshness invalidation reason, local pause state, and exclusive-control lease status. Pointer coordinates are viewport-normalized 0-1000 and describe browserControl's logical pointer, not the OS cursor.", inputSchema: EMPTY_SCHEMA },
    {
      name: "browser_observe",
      description: "Capture a screenshot of the currently shared Chrome tab. Coordinates use normalized 0-1000 values. This is slower than browser_snapshot but gives visual context for image-heavy or canvas-based pages. Prefer browser_snapshot for most tasks.",
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
      name: "browser_snapshot",
      description: "Take one fast DOM snapshot, then prepare a browser_action_queue for the known steps on this page. Interactive elements have [ref] markers and normalized 0-1000 coordinates using the observation's viewport dimensions. Labels, group names, matrix row/column headers and checked/selected/expanded states help identify complex form controls. Native selects list option indices, values, labels and selected/disabled states; focus the select and use keyboard arrows or type-ahead, then verify the selected option in a fresh snapshot. For custom dropdowns with a known option label or selector, queue opening the control, clicking that live target and clicking Continue in one call. Snapshot after opening only when the available options need discovery. visual-choice, visual-only images and canvases require browser_observe/browser_inspect when the choice depends on image content; use the screenshot to identify the choice, click its ref or observed coordinates, then verify its state. Offscreen elements have [offscreen] without click coordinates; use a DOM target to scroll them into view. focusedRef identifies focus; tabOrder lists top-document tab stops by ref (positive tabindex first, then document order, excluding disabled/inert controls and other radios in each group). Refs themselves are not tab order. Custom widgets, frames and shadow roots may handle focus differently, so establish focus explicitly when needed. Stop a queue where new options or layout information is needed. Pass the observationId to the planned queue, which returns the next snapshot.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_inspect",
      description: "Capture a higher-detail sub-region of an observation. The returned crop has its own normalized 0-1000 coordinate space mapped back to the source viewport. Pointer metadata remains viewport-normalized rather than crop-relative.",
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
    { name: "browser_move", description: "Move/hover the logical browser pointer at normalized coordinates from a specific observation. The action updates pointer state for later status/observation calls.", inputSchema: { type: "object" as const, properties: POINT_PROPERTIES, required: ["observationId", "x", "y"], additionalProperties: false } },
    { name: "browser_click", description: "Click at normalized coordinates from a specific observation. For standard DOM controls, the click point is randomized inside the same component's visible bounds. Updates the logical pointer to the actual click position. Stale observations are rejected.", inputSchema: { type: "object" as const, properties: { ...POINT_PROPERTIES, button: { type: "string", enum: ["left", "right", "middle"], default: "left" } }, required: ["observationId", "x", "y"], additionalProperties: false } },
    { name: "browser_double_click", description: "Double-click at normalized coordinates from a specific observation and update the logical pointer position.", inputSchema: { type: "object" as const, properties: { ...POINT_PROPERTIES, button: { type: "string", enum: ["left", "right", "middle"], default: "left" } }, required: ["observationId", "x", "y"], additionalProperties: false } },
    {
      name: "browser_drag",
      description: "Drag through a normalized waypoint path planned against one observation. Logical pointer state finishes at the final waypoint.",
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
      description: "Scroll at normalized coordinates using CSS-pixel wheel deltas from a fresh observation. The wheel position becomes the logical browser pointer position.",
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
    { name: "browser_type", description: "Type the given text into the focused element. Pass the full text you want typed (words, sentences, or paragraphs up to 5 000 chars) in a single call — the extension internally replays each character as real keyboard keystrokes so the page sees genuine key events. Do NOT call once per character; always send the complete text in one call. Requires a current observationId.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, text: { type: "string", maxLength: 5000 } }, required: ["observationId", "text"], additionalProperties: false } },
    { name: "browser_keypress", description: "Send a keyboard shortcut (e.g. Enter, Tab, Ctrl+A, Escape) only if the referenced observation is still current. For typing text use browser_type instead. Paste shortcuts (Ctrl+V, Cmd+V) are blocked — use browser_type to enter text.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, keys: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 50 } } }, required: ["observationId", "keys"], additionalProperties: false } },
    { name: "browser_navigate", description: "Navigate the shared tab to an http(s) URL. This deterministic recovery action does not require a fresh observation, including on dynamic pages and Chrome New Tab/about:blank.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, url: { type: "string", format: "uri", maxLength: 2048 } }, required: ["url"], additionalProperties: false } },
    { name: "browser_back", description: "Navigate the shared tab backward. A stale or omitted observation does not block this deterministic recovery action.", inputSchema: OPTIONAL_OBSERVATION_SCHEMA },
    { name: "browser_forward", description: "Navigate the shared tab forward. A stale or omitted observation does not block this deterministic recovery action.", inputSchema: OPTIONAL_OBSERVATION_SCHEMA },
    { name: "browser_reload", description: "Reload the shared tab. A stale or omitted observation does not block this deterministic recovery action.", inputSchema: OPTIONAL_OBSERVATION_SCHEMA },
    { name: "browser_tabs", description: "List Chrome tabs visible to this browserControl device. Read-only.", inputSchema: EMPTY_SCHEMA },
    { name: "browser_switch_tab", description: "Switch control to an explicit targetId returned by browser_tabs. No observation is required because the target tab is explicit.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, targetId: { type: "string", maxLength: 128 } }, required: ["targetId"], additionalProperties: false } },
    { name: "browser_new_tab", description: "Create a new tab. No observation is required. Only http://, https://, or about:blank are allowed.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, url: { type: "string", format: "uri", maxLength: 2048 } }, additionalProperties: false } },
    { name: "browser_close_tab", description: "Close a tab from a fresh observation. If targetId is omitted, close the currently shared tab.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, targetId: { type: "string", maxLength: 128 } }, required: ["observationId"], additionalProperties: false } },
    { name: "browser_handle_dialog", description: "Accept or dismiss the active JavaScript dialog from a fresh observation.", inputSchema: { type: "object" as const, properties: { observationId: { type: "string" }, accept: { type: "boolean" }, promptText: { type: "string", maxLength: 5000 } }, required: ["observationId", "accept"], additionalProperties: false } },
    {
      name: "browser_evaluate",
      description: "Evaluate a JavaScript expression in the context of the active tab. Useful for reading DOM state, setting complex inputs or dropdown values, and automating form interactions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          expression: { type: "string", maxLength: 20000 },
        },
        required: ["expression"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_click_element",
      description: "Click an interactive element resolved live in the page. You can target the element using 'ref' (1-based index from browser_snapshot), CSS 'selector', or visible 'text'. Resolves the element's live bounding rect at execution time and randomizes the click point inside it, with humanized hold duration and bounded release jitter. Eliminates coordinate staleness. For multiple known clicks or form inputs, prefer browser_action_queue to separate tool calls.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ref: { type: "number", minimum: 1, description: "1-based element index from browser_snapshot" },
          selector: { type: "string", maxLength: 1000, description: "CSS selector for the element" },
          text: { type: "string", maxLength: 200, description: "Visible text, button label, or placeholder to match" },
          button: { type: "string", enum: ["left", "middle", "right"], default: "left" },
          clickCount: { type: "number", minimum: 1, maximum: 3, default: 1 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_type_element",
      description: "Focus an input element and type text into it using humanized keystroke timing. You can target the element using 'ref' (1-based index from browser_snapshot), CSS 'selector', or 'queryText' (matching placeholder, label, etc.). Replays authentic keystrokes with realistic flight and hold times. For multiple known inputs or a type-then-click sequence, prefer browser_action_queue.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", maxLength: 5000, description: "Text to type into the focused element" },
          ref: { type: "number", minimum: 1, description: "1-based element index from browser_snapshot" },
          selector: { type: "string", maxLength: 1000, description: "CSS selector for the element" },
          queryText: { type: "string", maxLength: 200, description: "Placeholder or label text to find the input" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_wait_for",
      description: "Wait for a condition on the page. Resolves the moment the condition is met. Use 'text' to wait for specific text strings to appear, 'selector' to wait for a CSS selector, 'url' to wait for URL to match/change, or 'idle' to wait for network and DOM stability.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 200 },
            description: "Wait until any of these text strings appear in the page",
          },
          selector: { type: "string", maxLength: 1000, description: "Wait until this CSS selector matches a visible element" },
          url: { type: "string", maxLength: 2048, description: "Wait until the URL contains this substring" },
          idle: { type: "boolean", description: "Wait until no busy/loading indicators are present" },
          timeoutMs: { type: "number", minimum: 500, maximum: 30000, default: 10000, description: "Maximum wait time in ms" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_select_and_advance",
      description: "Single-turn composite action: click an option element, wait a realistic human reading/thinking dwell time, then click a continue/next/submit button, then wait for the page to transition. Returns a fresh DOM snapshot of the next page. Eliminates multi-turn LLM latency for surveys, quizzes, and wizard flows.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target: {
            type: "object",
            description: "The element to select/click first",
            properties: {
              ref: { type: "number", minimum: 1 },
              selector: { type: "string", maxLength: 1000 },
              text: { type: "string", maxLength: 200 },
            },
            additionalProperties: false,
          },
          advance: {
            type: "object",
            description: "The continue/next/submit button to click after selecting",
            properties: {
              ref: { type: "number", minimum: 1 },
              selector: { type: "string", maxLength: 1000 },
              text: { type: "string", maxLength: 200 },
            },
            additionalProperties: false,
          },
          dwellMs: { type: "number", minimum: 1000, maximum: 15000, default: 3500, description: "Cognitive dwell time between selection and advancing in ms" },
          waitText: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 200 },
            description: "Text patterns to wait for after advancing",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_action_queue",
      description: "Plan from one browser_snapshot/browser_observe/browser_inspect, then execute the known mouse and keyboard steps in ONE call; a fresh snapshot is returned at the end. Supports click, double_click, move, type, keypress, scroll and wait, with a random 50-100 ms pause between actions by default; explicit dwellMs is exact (0 skips the pause). For a known custom dropdown choice, queue opening City, clicking target.text Bangalore and clicking target.text Continue; the option is resolved after opening, with no intermediate snapshot or LLM call. Use a fresh snapshot if the options need discovery. DOM targets: item.target accepts ref, selector or text; these resolve live and may be used without observationId. Prefer selectors/text if element order changes. Coordinates: pass the observationId they came from and use normalized 0-1000 x/y on click/double_click/move/scroll. Supplied observations are checked once at queue start, and their source region is reused throughout, including inspected crops. Scroll without observationId uses the full current viewport. type without target types into the focused control; use snapshot focusedRef/tabOrder to plan separate keypress actions for Tab, Shift+Tab or arrow keys, establishing focus with a click first when needed. Do not use coordinates for [offscreen] targets. End the batch where navigation, scrolling, a popup or a layout change requires new information; a Next/Submit action should be last. Coordinate targets must stay in place across earlier steps. Example: {\"observationId\":\"…\",\"queue\":[{\"type\":\"click\",\"x\":412,\"y\":230},{\"type\":\"type\",\"text\":\"Ada\"},{\"type\":\"keypress\",\"keys\":[\"Tab\"]},{\"type\":\"type\",\"text\":\"ada@example.com\"}]}. Returns completedActions, per-action results and the next snapshot; failures stop at failedActionIndex (zero-based). Tab/navigation/viewport changes stop later actions with STALE_OBSERVATION; user pause returns CONTROL_PAUSED. Inspect before continuing a failed batch. timeoutMs controls the final wait, not the whole queue.",
      inputSchema: {
        type: "object" as const,
        properties: {
          observationId: { type: "string", description: "Observation used to plan the queue. Required for coordinate click/double_click/move; when supplied, scroll positions use its source region too." },
          queue: {
            type: "array",
            minItems: 1,
            description: "Actions in execution order. Put field values in item.text and the element locator in item.target, or use x/y coordinates from observationId.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["click", "double_click", "move", "type", "keypress", "scroll", "wait"], default: "click", description: "Action kind; defaults to click when omitted" },
                target: {
                  type: "object",
                  description: "DOM element to act on (click/double_click/move/type). Omit to use x/y coordinates, or for type to use the focused element.",
                  properties: {
                    ref: { type: "number", minimum: 1 },
                    selector: { type: "string", maxLength: 1000 },
                    text: { type: "string", maxLength: 200 },
                  },
                  additionalProperties: false,
                },
                text: { type: "string", maxLength: 5000, description: "Text to type (for type action)" },
                keys: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 50 }, description: "Keyboard shortcut for keypress, e.g. [\"Enter\"] or [\"Control\",\"A\"]" },
                button: { type: "string", enum: ["left", "right", "middle"], default: "left", description: "Mouse button for click/double_click" },
                dwellMs: { type: "number", minimum: 0, maximum: 15000, description: "Exact pause after this action in ms; 0 skips it. Omit for a random 50-100 ms gap between actions and no gap after the last action." },
                x: { type: "number", minimum: 0, maximum: 1000, description: "Normalized x within observationId's source region; scroll defaults to 500 and uses the full viewport if observationId is omitted" },
                y: { type: "number", minimum: 0, maximum: 1000, description: "Normalized y within observationId's source region; scroll defaults to 500 and uses the full viewport if observationId is omitted" },
                deltaX: { type: "number", minimum: -4000, maximum: 4000, description: "Horizontal scroll delta in CSS pixels" },
                deltaY: { type: "number", minimum: -4000, maximum: 4000, description: "Vertical scroll delta in CSS pixels" },
                ms: { type: "number", minimum: 0, maximum: 30000, default: 1000, description: "Wait duration in ms (for wait action)" },
              },
              additionalProperties: false,
            },
          },
          waitText: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 200 },
            description: "Wait until any of these texts appear after all actions. A timeout is reported as a failed queue.",
          },
          waitForIdle: { type: "boolean", default: true, description: "Wait for recognized busy/loading indicators to disappear after the queue" },
          timeoutMs: { type: "number", minimum: 500, maximum: 30000, default: 10000 },
        },
        required: ["queue"],
        additionalProperties: false,
      },
    },
    { name: "browser_release_control", description: "Release this MCP client's exclusive interactive-control lease for the browserControl device.", inputSchema: EMPTY_SCHEMA },
  ];
}

export function isPasteShortcut(keys: unknown[]): boolean {
  if (!Array.isArray(keys)) return false;
  let hasModifier = false;
  let hasV = false;
  for (const raw of keys) {
    const key = String(raw).toLowerCase();
    if (key === "paste") return true;
    if (["ctrl", "control", "cmd", "command", "meta", "super"].includes(key)) {
      hasModifier = true;
    } else if (key === "v") {
      hasV = true;
    }
  }
  return hasModifier && hasV;
}

function assertAllowedCall(method: string, args: Record<string, any>): Record<string, any> {
  const next = { ...args };
  if (method === "navigate") {
    if (typeof next.url !== "string") throw Object.assign(new Error("url is required"), { code: "UNSAFE_NAVIGATION_URL" });
    next.url = assertSafeNavigationUrl(next.url);
  } else if (method === "new_tab") {
    next.url = assertSafeNewTabUrl(typeof next.url === "string" ? next.url : undefined);
  } else if (method === "type" || method === "type_element") {
    if (typeof next.text === "string" && next.text.length > 5000) {
      throw Object.assign(new Error("type text must be at most 5000 characters"), { code: "INPUT_TOO_LARGE" });
    }
  } else if (method === "action_queue") {
    if (!Array.isArray(next.queue) || next.queue.length === 0) {
      throw Object.assign(new Error("queue must be a non-empty array of actions"), { code: "INVALID_PARAM" });
    }
    for (const [index, item] of next.queue.entries()) {
      if (!item || typeof item !== "object" || !QUEUE_ACTION_TYPES.includes(item.type || "click")) {
        throw Object.assign(new Error(`Unsupported queue action type at index ${index}: ${item?.type}`), { code: "INVALID_PARAM" });
      }
      const type = item.type || "click";
      if (type === "type") {
        if (typeof item.text !== "string") throw Object.assign(new Error(`queue[${index}].text is required for typing`), { code: "INVALID_PARAM" });
        assertAllowedCall("type", item);
      }
      if (type === "keypress") {
        if (!Array.isArray(item.keys) || item.keys.length === 0) {
          throw Object.assign(new Error(`queue[${index}].keys must be a non-empty array for keypress`), { code: "INVALID_PARAM" });
        }
        assertAllowedCall("keypress", item);
      }
      if (type === "scroll") assertAllowedCall("scroll", item);
      if (item.target != null) {
        const target = item.target;
        if (typeof target !== "object" || (target.ref == null && !target.selector && !target.text)) {
          throw Object.assign(new Error(`queue[${index}].target needs ref, selector, or text`), { code: "INVALID_PARAM" });
        }
      } else if (type === "click" || type === "double_click" || type === "move") {
        const hasPoint = item.x != null || item.y != null;
        if (hasPoint) {
          for (const field of ["x", "y"] as const) {
            const value = item[field];
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000) {
              throw Object.assign(new Error(`queue[${index}].${field} must be a number between 0 and 1000`), { code: "INVALID_PARAM" });
            }
          }
          if (typeof next.observationId !== "string" || !next.observationId) {
            throw Object.assign(
              new Error(`queue[${index}] uses x/y coordinates, so the queue needs the observationId they came from`),
              { code: "OBSERVATION_REQUIRED" },
            );
          }
        } else if (type === "move" || typeof item.text !== "string") {
          throw Object.assign(new Error(`queue[${index}] ${type} needs a target or x/y coordinates`), { code: "INVALID_PARAM" });
        }
      }
      for (const [field, maximum] of [["dwellMs", 15000], ["ms", 30000]] as const) {
        const value = item[field];
        if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum)) {
          throw Object.assign(new Error(`queue[${index}].${field} must be between 0 and ${maximum}`), { code: "INVALID_PARAM" });
        }
      }
    }
  } else if (method === "select_and_advance") {
    if (next.dwellMs != null && (typeof next.dwellMs !== "number" || next.dwellMs < 1000 || next.dwellMs > 15000)) {
      throw Object.assign(new Error("dwellMs must be between 1000 and 15000"), { code: "INVALID_PARAM" });
    }
  } else if (method === "keypress") {
    if (Array.isArray(next.keys)) {
      if (next.keys.length > 10) throw Object.assign(new Error("keys must have at most 10 entries"), { code: "INPUT_TOO_LARGE" });
      for (const key of next.keys) {
        if (typeof key !== "string" || key.length > 50) {
          throw Object.assign(new Error("each key must be at most 50 characters"), { code: "INPUT_TOO_LARGE" });
        }
      }
      if (isPasteShortcut(next.keys)) {
        throw Object.assign(
          new Error("Pasting via keyboard shortcut is disabled. Agents must use the keyboard (browser_type) to type text instead."),
          { code: "PASTE_DISABLED" }
        );
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
    if (method === "action_queue") {
      const timeoutMs = actionQueueTimeoutMs(safeParams);
      const keepLease = setInterval(() => route.lease.acquire(clientId), 10_000);
      try {
        return await route.bridge.call(method, safeParams, timeoutMs);
      } finally {
        clearInterval(keepLease);
      }
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
      case "browser_snapshot": return textResult(await route.bridge.call("snapshot", args));
      case "browser_inspect": return imageResult(await route.bridge.call("inspect_region", args));
      case "browser_move": return textResult(await mutate("move", args));
      case "browser_click": {
        try {
          return textResult(await mutate("click", args));
        } catch (e: any) {
          if (e?.code === "STALE_OBSERVATION" && args.observationId) {
            const snap = await route.bridge.call("snapshot", {});
            args.observationId = snap.observationId;
            return textResult(await mutate("click", args));
          }
          throw e;
        }
      }
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
      case "browser_evaluate": return textResult(await mutate("evaluate", args));
      case "browser_click_element": return textResult(await mutate("click_element", args));
      case "browser_type_element": return textResult(await mutate("type_element", args));
      case "browser_wait_for": return textResult(await route.bridge.call("wait_for", args));
      case "browser_select_and_advance": return textResult(await mutate("select_and_advance", args));
      case "browser_action_queue": {
        const result = await mutate("action_queue", args);
        return { ...textResult(result), ...(result.success === false ? { isError: true } : {}) };
      }
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
    { name: options.name || "browser-control", version: options.version || "0.7.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: browserTools() }));
  server.setRequestHandler("tools/call", async (request: any) => {
    const args = (request.params?.arguments || {}) as Record<string, any>;
    return handleBrowserToolCall(route, clientId, request.params?.name, args);
  });
  return server;
}
