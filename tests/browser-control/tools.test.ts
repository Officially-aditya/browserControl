import { describe, expect, it, vi } from "vitest";
import { ControlLease, type BrowserRoute } from "../../src/browser-control/bridge.js";
import { browserTools, handleBrowserToolCall } from "../../src/browser-control/tools.js";

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
});
