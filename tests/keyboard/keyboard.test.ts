import { describe, it, expect, vi } from "vitest";
import { KeyboardController } from "../../src/input/keyboard.js";
import { MouseController } from "../../src/input/mouse.js";
import { InputStateManager, MODIFIERS } from "../../src/input/state.js";

describe("Keyboard Controller with InputStateManager", () => {
  it("should dispatch modifier bitmasks and editing commands correctly for Meta+A", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];

    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const keyboard = new KeyboardController(mockSession, inputState);
    await keyboard.keypress(["Meta", "a"]);

    expect(sentMessages.length).toBe(2);
    // rawKeyDown with editing command
    expect(sentMessages[0].method).toBe("Input.dispatchKeyEvent");
    expect(sentMessages[0].params.type).toBe("rawKeyDown");
    expect(sentMessages[0].params.modifiers).toBe(MODIFIERS.Meta);
    expect(sentMessages[0].params.code).toBe("KeyA");
    expect(sentMessages[0].params.commands).toEqual(["SelectAll"]);

    // keyUp
    expect(sentMessages[1].method).toBe("Input.dispatchKeyEvent");
    expect(sentMessages[1].params.type).toBe("keyUp");
  });

  it("should update InputState on key_down and key_up with modifier aliases", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];
    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const keyboard = new KeyboardController(mockSession, inputState);

    // key down using alias "cmd"
    await keyboard.keyDown("cmd");
    expect(inputState.modifierBitmask).toBe(MODIFIERS.Meta);
    expect(inputState.pressedKeys.has("Meta")).toBe(true);

    // key up using "Meta"
    await keyboard.keyUp("Meta");
    expect(inputState.modifierBitmask).toBe(0);
    expect(inputState.pressedKeys.has("Meta")).toBe(false);
  });

  it("should dispatch key_events method on typing", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];
    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const keyboard = new KeyboardController(mockSession, inputState);
    await keyboard.type("Hi", "key_events");

    expect(sentMessages.length).toBe(6);
    expect(sentMessages[0].params.text).toBe("H");
    expect(sentMessages[0].params.modifiers).toBe(MODIFIERS.Shift);
    expect(sentMessages[3].params.text).toBe("i");
    expect(sentMessages[3].params.modifiers).toBe(0);
  });

  it("should reset held keys without erasing held mouse state", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];
    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const keyboard = new KeyboardController(mockSession, inputState);
    const mouse = new MouseController(mockSession, inputState);

    // Hold Shift, Meta, and left mouse button
    inputState.setKeyDown("Shift");
    inputState.setKeyDown("Meta");
    inputState.setMouseDown("left");

    expect(inputState.modifierBitmask).toBe(12); // Shift(8) + Meta(4)
    expect(inputState.buttonsBitmask).toBe(1);

    // Reset keyboard
    await keyboard.reset();

    // Keyboard keys released, but mouse button state preserved!
    expect(inputState.modifierBitmask).toBe(0);
    expect(inputState.pressedKeys.size).toBe(0);
    expect(inputState.buttonsBitmask).toBe(1);
    expect(inputState.pressedButtons.has("left")).toBe(true);

    const keyUpEvents = sentMessages.filter((m) => m.method === "Input.dispatchKeyEvent" && m.params?.type === "keyUp");
    expect(keyUpEvents.length).toBe(2);

    // Now reset mouse
    await mouse.reset();
    expect(inputState.buttonsBitmask).toBe(0);
    expect(inputState.pressedButtons.size).toBe(0);
  });
});
