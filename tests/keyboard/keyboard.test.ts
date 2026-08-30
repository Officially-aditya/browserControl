import { describe, it, expect, vi } from "vitest";
import { KeyboardController, MODIFIERS } from "../../src/input/keyboard.js";

describe("Keyboard Controller", () => {
  it("should dispatch modifier bitmasks correctly for Meta+A", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];

    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const keyboard = new KeyboardController(mockSession);
    await keyboard.keypress(["Meta", "a"]);

    expect(sentMessages.length).toBe(2);
    // rawKeyDown
    expect(sentMessages[0].method).toBe("Input.dispatchKeyEvent");
    expect(sentMessages[0].params.type).toBe("rawKeyDown");
    expect(sentMessages[0].params.modifiers).toBe(MODIFIERS.Meta);
    expect(sentMessages[0].params.code).toBe("KeyA");

    // keyUp
    expect(sentMessages[1].method).toBe("Input.dispatchKeyEvent");
    expect(sentMessages[1].params.type).toBe("keyUp");
  });

  it("should dispatch Shift+Tab correctly", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];

    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const keyboard = new KeyboardController(mockSession);
    await keyboard.keypress(["Shift", "Tab"]);

    expect(sentMessages[0].params.modifiers).toBe(MODIFIERS.Shift);
    expect(sentMessages[0].params.key).toBe("Tab");
    expect(sentMessages[0].params.windowsVirtualKeyCode).toBe(9);
  });

  it("should dispatch insertText for type action", async () => {
    const sentMessages: Array<{ method: string; params: any }> = [];

    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentMessages.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const keyboard = new KeyboardController(mockSession);
    await keyboard.type("user@example.com");

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].method).toBe("Input.insertText");
    expect(sentMessages[0].params).toEqual({ text: "user@example.com" });
  });
});
