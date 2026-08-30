import { describe, it, expect, vi } from "vitest";
import { KeyboardController } from "../../src/input/keyboard.js";
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

  it("should update InputState on key_down and key_up", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];
    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const inputState = new InputStateManager();
    const keyboard = new KeyboardController(mockSession, inputState);

    // key down Shift
    await keyboard.keyDown("Shift");
    expect(inputState.modifierBitmask).toBe(MODIFIERS.Shift);
    expect(inputState.pressedKeys.has("Shift")).toBe(true);

    // key up Shift
    await keyboard.keyUp("Shift");
    expect(inputState.modifierBitmask).toBe(0);
    expect(inputState.pressedKeys.has("Shift")).toBe(false);
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

    // 'H' (rawKeyDown + char + keyUp) + 'i' (rawKeyDown + char + keyUp)
    expect(sentMessages.length).toBe(6);
    expect(sentMessages[0].params.text).toBe("H");
    expect(sentMessages[0].params.modifiers).toBe(MODIFIERS.Shift);
    expect(sentMessages[3].params.text).toBe("i");
    expect(sentMessages[3].params.modifiers).toBe(0);
  });
});
