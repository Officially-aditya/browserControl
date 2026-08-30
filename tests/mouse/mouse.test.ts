import { describe, it, expect, vi } from "vitest";
import { MouseController } from "../../src/input/mouse.js";
import { DragController } from "../../src/input/drag.js";
import { KeyboardController } from "../../src/input/keyboard.js";
import { InputStateManager } from "../../src/input/state.js";

describe("Mouse & Drag Controllers with InputStateManager", () => {
  it("should dispatch correct CDP mouse event sequence for click and update state", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];

    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const mouse = new MouseController(mockSession, inputState);
    await mouse.click(350, 200, "left");

    expect(sentMessages.length).toBe(3);
    expect(sentMessages[0].method).toBe("Input.dispatchMouseEvent");
    expect(sentMessages[0].params).toEqual({
      type: "mouseMoved",
      x: 350,
      y: 200,
      button: "none",
      buttons: 0,
      modifiers: 0,
    });

    expect(sentMessages[1].method).toBe("Input.dispatchMouseEvent");
    expect(sentMessages[1].params).toEqual({
      type: "mousePressed",
      x: 350,
      y: 200,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    });

    expect(sentMessages[2].method).toBe("Input.dispatchMouseEvent");
    expect(sentMessages[2].params).toEqual({
      type: "mouseReleased",
      x: 350,
      y: 200,
      button: "left",
      buttons: 0,
      clickCount: 1,
      modifiers: 0,
    });

    expect(mouse.position).toEqual({ x: 350, y: 200 });
  });

  it("should preserve pressed buttons in InputState during down -> move -> up sequence", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];
    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const mouse = new MouseController(mockSession, inputState);

    // 1. Mouse down left button
    await mouse.down(100, 100, "left");
    expect(inputState.buttonsBitmask).toBe(1);

    // 2. Move while button is held
    await mouse.move(150, 100);
    expect(sentMessages[sentMessages.length - 1].params.buttons).toBe(1);

    // 3. Mouse up
    await mouse.up(150, 100, "left");
    expect(inputState.buttonsBitmask).toBe(0);
  });

  it("should split large scrolls into smooth increments", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];
    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const mouse = new MouseController(mockSession, inputState);
    await mouse.scroll(200, 300, 0, 400);

    const wheelEvents = sentMessages.filter((m) => m.params?.type === "mouseWheel");
    expect(wheelEvents.length).toBeGreaterThanOrEqual(3);

    const totalDeltaY = wheelEvents.reduce((acc, curr) => acc + curr.params.deltaY, 0);
    expect(Math.round(totalDeltaY)).toBe(400);
  });

  it("should execute multi-point drag path with intermediate steps", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];
    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const drag = new DragController(mockSession, inputState);
    await drag.drag([
      { x: 100, y: 100 },
      { x: 150, y: 120 },
      { x: 200, y: 150 },
    ]);

    expect(sentMessages[0].params.type).toBe("mouseMoved");
    expect(sentMessages[1].params.type).toBe("mousePressed");
    const lastEvent = sentMessages[sentMessages.length - 1];
    expect(lastEvent.params.type).toBe("mouseReleased");
    expect(lastEvent.params.x).toBe(200);
    expect(lastEvent.params.y).toBe(150);
  });

  it("should reset held mouse buttons without erasing held keyboard state", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];
    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const mouse = new MouseController(mockSession, inputState);
    const keyboard = new KeyboardController(mockSession, inputState);

    // Hold Shift key and hold left mouse button
    inputState.setKeyDown("Shift");
    inputState.setMouseDown("left");
    inputState.setMouseDown("right");

    expect(inputState.modifierBitmask).toBe(8);
    expect(inputState.buttonsBitmask).toBe(3); // 1 + 2

    // Reset mouse controller
    await mouse.reset();

    // Mouse buttons released, but keyboard keys preserved!
    expect(inputState.buttonsBitmask).toBe(0);
    expect(inputState.pressedButtons.size).toBe(0);
    expect(inputState.modifierBitmask).toBe(8);
    expect(inputState.pressedKeys.has("Shift")).toBe(true);

    const releasedEvents = sentMessages.filter((m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseReleased");
    expect(releasedEvents.length).toBe(2);

    // Now reset keyboard controller
    await keyboard.reset();
    expect(inputState.modifierBitmask).toBe(0);
    expect(inputState.pressedKeys.size).toBe(0);

    const keyUpEvents = sentMessages.filter((m) => m.method === "Input.dispatchKeyEvent" && m.params?.type === "keyUp");
    expect(keyUpEvents.length).toBe(1);
    expect(keyUpEvents[0].params.key).toBe("Shift");
  });

  it("should cleanly release simultaneous held keys and held mouse buttons on reset_input", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];
    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const mouse = new MouseController(mockSession, inputState);
    const keyboard = new KeyboardController(mockSession, inputState);

    // Hold multiple keys and multiple buttons simultaneously
    inputState.setKeyDown("Shift");
    inputState.setKeyDown("Control");
    inputState.setKeyDown("Meta");
    inputState.setKeyDown("a");
    inputState.setMouseDown("left");
    inputState.setMouseDown("right");
    inputState.setMouseDown("middle");

    expect(inputState.pressedKeys.size).toBe(4);
    expect(inputState.modifierBitmask).toBe(14); // Shift(8) + Control(2) + Meta(4)
    expect(inputState.pressedButtons.size).toBe(3);
    expect(inputState.buttonsBitmask).toBe(7); // left(1) + right(2) + middle(4)

    // Execute full reset_input sequence
    await mouse.reset();
    await keyboard.reset();

    // Verify all states completely cleared
    expect(inputState.pressedKeys.size).toBe(0);
    expect(inputState.modifierBitmask).toBe(0);
    expect(inputState.pressedButtons.size).toBe(0);
    expect(inputState.buttonsBitmask).toBe(0);

    // Verify CDP messages
    const cancelDragging = sentMessages.filter((m) => m.method === "Input.cancelDragging");
    expect(cancelDragging.length).toBe(1);

    const releasedButtons = sentMessages
      .filter((m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mouseReleased")
      .map((m) => m.params.button);
    expect(releasedButtons).toContain("left");
    expect(releasedButtons).toContain("right");
    expect(releasedButtons).toContain("middle");

    const releasedKeys = sentMessages
      .filter((m) => m.method === "Input.dispatchKeyEvent" && m.params?.type === "keyUp")
      .map((m) => m.params.key);
    expect(releasedKeys).toContain("Shift");
    expect(releasedKeys).toContain("Control");
    expect(releasedKeys).toContain("Meta");
    expect(releasedKeys).toContain("a");
  });
});

