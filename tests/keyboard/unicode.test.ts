import { describe, it, expect, vi } from "vitest";
import { KeyboardController } from "../../src/input/keyboard.js";
import { InputStateManager } from "../../src/input/state.js";

describe("Unicode & Multi-byte Typing Suite", () => {
  it("should correctly dispatch multi-byte emojis without breaking surrogate pairs in key_events mode", async () => {
    const sentEvents: Array<{ method: string; params: any }> = [];

    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentEvents.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const keyboard = new KeyboardController(mockSession, new InputStateManager());

    // Type 2 emojis: 🚀 (U+1F680) and 🎉 (U+1F389)
    await keyboard.type("🚀🎉", "key_events");

    // Each emoji must produce 1 rawKeyDown, 1 char, and 1 keyUp with the complete emoji string
    expect(sentEvents.length).toBe(6);

    // First emoji: 🚀
    expect(sentEvents[0].params.text).toBe("🚀");
    expect(sentEvents[1].params.text).toBe("🚀");
    expect(sentEvents[1].params.type).toBe("char");

    // Second emoji: 🎉
    expect(sentEvents[3].params.text).toBe("🎉");
    expect(sentEvents[4].params.text).toBe("🎉");
    expect(sentEvents[4].params.type).toBe("char");
  });

  it("should type international multi-lingual scripts (CJK, Cyrillic, Arabic, Accents) in auto mode", async () => {
    const sentEvents: Array<{ method: string; params: any }> = [];

    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentEvents.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const keyboard = new KeyboardController(mockSession, new InputStateManager());

    // Chinese + Arabic + Accents
    const sampleText = "你好 مرحبا café";
    await keyboard.type(sampleText, "auto");

    const insertEvents = sentEvents.filter((e) => e.method === "Input.insertText");
    const insertedChars = insertEvents.map((e) => e.params.text).join("");

    expect(insertedChars).toBe(sampleText);
  });

  it("should type mathematical and currency symbols in insert_text mode", async () => {
    const sentEvents: Array<{ method: string; params: any }> = [];

    const mockSession = {
      send: vi.fn().mockImplementation((method: string, params: any) => {
        sentEvents.push({ method, params });
        return Promise.resolve({});
      }),
    } as any;

    const keyboard = new KeyboardController(mockSession, new InputStateManager());

    const mathSymbols = "∑(x) = √π · ∞ ≠ €50";
    await keyboard.type(mathSymbols, "insert_text");

    expect(sentEvents.length).toBe(1);
    expect(sentEvents[0].method).toBe("Input.insertText");
    expect(sentEvents[0].params.text).toBe(mathSymbols);
  });
});
