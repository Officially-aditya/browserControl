import { describe, it, expect, vi } from "vitest";
import { MouseController } from "../../src/input/mouse.js";
import { DragController } from "../../src/input/drag.js";
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
});
