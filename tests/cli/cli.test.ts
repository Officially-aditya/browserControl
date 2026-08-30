import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliSession } from "../../src/cli/index.js";

describe("CLI REPL & Command Handlers Suite", () => {
  let mockController: any;
  let cli: CliSession;

  beforeEach(() => {
    mockController = {
      currentTargetId: "target-123",
      session: { visualEpoch: 1 },
      activeDialog: null,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      doctor: vi.fn().mockResolvedValue({ connected: true, visualEpoch: 1, sessionState: "READY" }),
      observe: vi.fn().mockResolvedValue({
        observationId: "obs-abc-123",
        visualEpoch: 1,
        viewportWidth: 1280,
        viewportHeight: 800,
        imageWidth: 1280,
        imageHeight: 800,
        coordinateSpace: { scaleX: 1, scaleY: 1 },
        image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      }),
      executeComputerAction: vi.fn().mockImplementation((action: any) =>
        Promise.resolve({ id: "act-1", success: true, action: action.type })
      ),
      executeBrowserAction: vi.fn().mockImplementation((action: any) =>
        Promise.resolve({ id: "act-2", success: true, action: action.type })
      ),
      resetInputState: vi.fn().mockResolvedValue(undefined),
      getTabs: vi.fn().mockResolvedValue([{ targetId: "target-123", title: "Tab 1", url: "https://example.com" }]),
      getWindows: vi.fn().mockResolvedValue([{ windowId: 1, targetIds: ["target-123"], activeTargetId: "target-123" }]),
    };

    cli = new CliSession(mockController, (opts) => ({
      ...mockController,
      currentTargetId: `target-reconnected-${opts.mode}`,
    } as any));
  });

  it("should handle help command", async () => {
    const res = await cli.handleCommand("help");
    expect(res.commands).toBeDefined();
    expect(res.commands.length).toBeGreaterThanOrEqual(15);
  });

  it("should handle doctor command", async () => {
    const res = await cli.handleCommand("doctor");
    expect(mockController.doctor).toHaveBeenCalled();
    expect(res.connected).toBe(true);
  });

  it("should handle nav command", async () => {
    await cli.handleCommand("nav https://google.com");
    expect(mockController.executeBrowserAction).toHaveBeenCalledWith({
      type: "navigate",
      url: "https://google.com",
    });
  });

  it("should handle observe command and cache observationId", async () => {
    const res = await cli.handleCommand("observe");
    expect(mockController.observe).toHaveBeenCalled();
    expect(cli.lastObservationId).toBe("obs-abc-123");
    expect(res.observationId).toBe("obs-abc-123");
  });

  it("should handle coordinate computer actions (click, dblclick, move, down, up, scroll, drag)", async () => {
    cli.lastObservationId = "obs-1";

    // Click
    await cli.handleCommand("click 150 250 right");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "click",
      observationId: "obs-1",
      x: 150,
      y: 250,
      button: "right",
    });

    // Double click
    await cli.handleCommand("dblclick 300 400");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "double_click",
      observationId: "obs-1",
      x: 300,
      y: 400,
      button: "left",
    });

    // Move
    await cli.handleCommand("move 50 75");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "move",
      observationId: "obs-1",
      x: 50,
      y: 75,
    });

    // Down
    await cli.handleCommand("down 100 100 left");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "down",
      observationId: "obs-1",
      x: 100,
      y: 100,
      button: "left",
    });

    // Up
    await cli.handleCommand("up 100 100 left");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "up",
      observationId: "obs-1",
      x: 100,
      y: 100,
      button: "left",
    });

    // Scroll
    await cli.handleCommand("scroll 200 300 150 20");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "scroll",
      observationId: "obs-1",
      x: 200,
      y: 300,
      deltaX: 20,
      deltaY: 150,
    });

    // Drag
    await cli.handleCommand("drag 100,100 200,200 300,300");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "drag",
      observationId: "obs-1",
      path: [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
        { x: 300, y: 300 },
      ],
    });
  });

  it("should handle keyboard commands (type, keypress, keydown, keyup, reset-input)", async () => {
    // Type
    await cli.handleCommand("type Hello World");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "type",
      text: "Hello World",
      method: "auto",
    });

    // Keypress
    await cli.handleCommand("keypress Meta a");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "keypress",
      keys: ["Meta", "a"],
    });

    // Keydown
    await cli.handleCommand("keydown Shift");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "key_down",
      key: "Shift",
    });

    // Keyup
    await cli.handleCommand("keyup Shift");
    expect(mockController.executeComputerAction).toHaveBeenCalledWith({
      type: "key_up",
      key: "Shift",
    });

    // Reset input
    await cli.handleCommand("reset-input");
    expect(mockController.resetInputState).toHaveBeenCalled();
  });

  it("should handle tab, window, and dialog commands", async () => {
    // Tabs
    await cli.handleCommand("tabs");
    expect(mockController.getTabs).toHaveBeenCalled();

    await cli.handleCommand("tab target-456");
    expect(mockController.executeBrowserAction).toHaveBeenCalledWith({
      type: "switch_tab",
      targetId: "target-456",
    });

    await cli.handleCommand("newtab https://google.com");
    expect(mockController.executeBrowserAction).toHaveBeenCalledWith({
      type: "new_tab",
      url: "https://google.com",
    });

    await cli.handleCommand("closetab target-123");
    expect(mockController.executeBrowserAction).toHaveBeenCalledWith({
      type: "close_tab",
      targetId: "target-123",
    });

    // Windows
    await cli.handleCommand("windows");
    expect(mockController.getWindows).toHaveBeenCalled();

    await cli.handleCommand("newwindow https://bing.com");
    expect(mockController.executeBrowserAction).toHaveBeenCalledWith({
      type: "new_window",
      url: "https://bing.com",
    });

    await cli.handleCommand("closewindow 2");
    expect(mockController.executeBrowserAction).toHaveBeenCalledWith({
      type: "close_window",
      windowId: 2,
    });

    // Dialogs
    await cli.handleCommand("dialog-accept confirm answer");
    expect(mockController.executeBrowserAction).toHaveBeenCalledWith({
      type: "handle_dialog",
      accept: true,
      promptText: "confirm answer",
    });

    await cli.handleCommand("dialog-dismiss");
    expect(mockController.executeBrowserAction).toHaveBeenCalledWith({
      type: "handle_dialog",
      accept: false,
    });
  });

  it("should properly replace connection and reconnect on 'connect' and 'auto-connect'", async () => {
    // 1. Reconnect with explicit port and host
    const connectRes = await cli.handleCommand("connect 9333 127.0.0.1");
    expect(mockController.disconnect).toHaveBeenCalled();
    expect(cli.controller).not.toBe(mockController); // Successfully swapped controller instance!
    expect(connectRes.endpoint).toBe("http://127.0.0.1:9333");

    // 2. Auto-connect
    const oldCtrl = cli.controller;
    const autoRes = await cli.handleCommand("auto-connect");
    expect(cli.controller).not.toBe(oldCtrl); // Successfully created fresh auto controller!
    expect(autoRes.status).toBe("connected");
  });
});
