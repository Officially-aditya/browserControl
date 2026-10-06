import { describe, expect, it, vi } from "vitest";
import { ControlLease, type BrowserRoute } from "../../src/browser-control/bridge.js";
import { browserTools, handleBrowserToolCall, isPasteShortcut } from "../../src/browser-control/tools.js";

function fakeRoute(callImpl?: (method: string, params: Record<string, any>) => any): BrowserRoute {
  return {
    deviceId: "test-device",
    lease: new ControlLease(),
    bridge: {
      connected: true,
      call: vi.fn(async (method: string, params: Record<string, any> = {}) => {
        if (callImpl) return callImpl(method, params);
        return { success: true };
      }),
    } as any,
  };
}

describe("canonical browserControl tools", () => {
  it("exposes the same browser_* surface for every transport", () => {
    expect(browserTools().map((tool) => tool.name)).toEqual([
      "browser_status",
      "browser_observe",
      "browser_snapshot",
      "browser_inspect",
      "browser_move",
      "browser_click",
      "browser_double_click",
      "browser_drag",
      "browser_scroll",
      "browser_type",
      "browser_keypress",
      "browser_navigate",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_tabs",
      "browser_switch_tab",
      "browser_new_tab",
      "browser_close_tab",
      "browser_handle_dialog",
      "browser_evaluate",
      "browser_click_element",
      "browser_type_element",
      "browser_wait_for",
      "browser_select_and_advance",
      "browser_action_queue",
      "browser_release_control",
    ]);
  });

  it("returns screenshots as MCP image content", async () => {
    const route = fakeRoute((method) => {
      expect(method).toBe("observe");
      return {
        observationId: "obs-1",
        visualEpoch: 1,
        mimeType: "image/jpeg",
        image: "ZmFrZQ==",
      };
    });

    const result = await handleBrowserToolCall(route, "client-a", "browser_observe", {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ observationId: "obs-1", visualEpoch: 1 }, null, 2),
      },
      { type: "image", data: "ZmFrZQ==", mimeType: "image/jpeg" },
    ]);
  });

  it("blocks unsafe navigation before the extension bridge", async () => {
    const route = fakeRoute();
    const result = await handleBrowserToolCall(route, "client-a", "browser_navigate", {
      observationId: "obs-1",
      url: "file:///etc/passwd",
    });

    expect(result.isError).toBe(true);
    expect((route.bridge.call as any).mock.calls).toHaveLength(0);
    expect(JSON.parse(result.content[0].text).errorCode).toBe("UNSAFE_NAVIGATION_URL");
  });

  it("keeps deterministic recovery tools callable without observations", () => {
    const tools = new Map(browserTools().map((tool) => [tool.name, tool]));
    expect((tools.get("browser_navigate")?.inputSchema as any).required).toEqual(["url"]);
    expect((tools.get("browser_reload")?.inputSchema as any).required).toBeUndefined();
    expect((tools.get("browser_back")?.inputSchema as any).required).toBeUndefined();
    expect((tools.get("browser_forward")?.inputSchema as any).required).toBeUndefined();
    expect((tools.get("browser_switch_tab")?.inputSchema as any).required).toEqual(["targetId"]);
    expect((tools.get("browser_new_tab")?.inputSchema as any).required).toBeUndefined();
  });

  it("passes recovery calls through even when no observation is supplied", async () => {
    const route = fakeRoute();
    const navigated = await handleBrowserToolCall(route, "client-a", "browser_navigate", {
      url: "https://example.com/",
    });
    const reloaded = await handleBrowserToolCall(route, "client-a", "browser_reload", {});
    const opened = await handleBrowserToolCall(route, "client-a", "browser_new_tab", {
      url: "https://example.com/compose",
    });

    expect(navigated.isError).toBeUndefined();
    expect(reloaded.isError).toBeUndefined();
    expect(opened.isError).toBeUndefined();
    expect((route.bridge.call as any).mock.calls).toEqual([
      ["navigate", { url: "https://example.com/" }],
      ["reload", {}],
      ["new_tab", { url: "https://example.com/compose" }],
    ]);
  });

  it("keeps the interactive lease transport independent", async () => {
    const route = fakeRoute();
    await handleBrowserToolCall(route, "client-a", "browser_click", {
      observationId: "obs-1",
      x: 100,
      y: 100,
    });
    const blocked = await handleBrowserToolCall(route, "client-b", "browser_click", {
      observationId: "obs-2",
      x: 200,
      y: 200,
    });

    expect(blocked.isError).toBe(true);
    expect(JSON.parse(blocked.content[0].text).errorCode).toBe("DEVICE_BUSY");
  });

  it("detects paste shortcuts and disallows them to force keyboard typing", async () => {
    expect(isPasteShortcut(["Control", "v"])).toBe(true);
    expect(isPasteShortcut(["ctrl", "v"])).toBe(true);
    expect(isPasteShortcut(["Meta", "v"])).toBe(true);
    expect(isPasteShortcut(["cmd", "v"])).toBe(true);
    expect(isPasteShortcut(["paste"])).toBe(true);
    expect(isPasteShortcut(["Control", "c"])).toBe(false);
    expect(isPasteShortcut(["Enter"])).toBe(false);

    const route = fakeRoute();
    const pasteAttempt = await handleBrowserToolCall(route, "client-a", "browser_keypress", {
      observationId: "obs-1",
      keys: ["Control", "v"],
    });

    expect(pasteAttempt.isError).toBe(true);
    expect((route.bridge.call as any).mock.calls).toHaveLength(0);
    const parsed = JSON.parse(pasteAttempt.content[0].text);
    expect(parsed.errorCode).toBe("PASTE_DISABLED");
    expect(parsed.message).toContain("Pasting via keyboard shortcut is disabled");

    const validShortcut = await handleBrowserToolCall(route, "client-a", "browser_keypress", {
      observationId: "obs-1",
      keys: ["Control", "a"],
    });
    expect(validShortcut.isError).toBeUndefined();
    expect((route.bridge.call as any).mock.calls).toHaveLength(1);
    expect((route.bridge.call as any).mock.calls[0]).toEqual(["keypress", { observationId: "obs-1", keys: ["Control", "a"] }]);
  });

  it("handles element targeted actions and composite advance", async () => {
    const route = fakeRoute((method, params) => {
      if (method === "click_element") return { success: true, visualEpoch: 2 };
      if (method === "type_element") return { success: true, visualEpoch: 3 };
      if (method === "wait_for") return { success: true, reason: "idle", elapsed: 200 };
      if (method === "select_and_advance") return { success: true, visualEpoch: 4, dom: "new page" };
      throw new Error(`Unexpected method ${method}`);
    });

    const clickRes = await handleBrowserToolCall(route, "client-a", "browser_click_element", { ref: 3 });
    expect(clickRes.isError).toBeUndefined();
    expect(JSON.parse(clickRes.content[0].text).success).toBe(true);

    const typeRes = await handleBrowserToolCall(route, "client-a", "browser_type_element", { ref: 3, text: "hello" });
    expect(typeRes.isError).toBeUndefined();
    expect(JSON.parse(typeRes.content[0].text).success).toBe(true);

    const waitRes = await handleBrowserToolCall(route, "client-a", "browser_wait_for", { idle: true });
    expect(waitRes.isError).toBeUndefined();
    expect(JSON.parse(waitRes.content[0].text).reason).toBe("idle");

    const advanceRes = await handleBrowserToolCall(route, "client-a", "browser_select_and_advance", {
      target: { ref: 2 },
      advance: { text: "Next" },
      dwellMs: 2000,
    });
    expect(advanceRes.isError).toBeUndefined();
    expect(JSON.parse(advanceRes.content[0].text).dom).toBe("new page");
  });

  it("auto-retries browser_click on STALE_OBSERVATION by taking a fresh snapshot", async () => {
    let callCount = 0;
    const route = fakeRoute((method, params) => {
      if (method === "click") {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error("STALE_OBSERVATION");
          err.code = "STALE_OBSERVATION";
          throw err;
        }
        return { success: true, observationId: params.observationId };
      }
      if (method === "snapshot") {
        return { observationId: "obs-fresh", visualEpoch: 5 };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const res = await handleBrowserToolCall(route, "client-a", "browser_click", {
      observationId: "obs-stale",
      x: 100,
      y: 100,
    });

    expect(res.isError).toBeUndefined();
    expect(callCount).toBe(2);
    expect(JSON.parse(res.content[0].text).observationId).toBe("obs-fresh");
  });
});
