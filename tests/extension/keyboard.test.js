import { describe, expect, it } from "vitest";
import { editingCommands, keyDefinition, keyEvents, normalizeShortcut } from "../../extension/keyboard.js";

describe("extension keyboard helpers", () => {
  it("normalizes modifier aliases", () => {
    expect(normalizeShortcut(["cmd", "a"])).toEqual({ modifiers: 4, key: "a" });
    expect(normalizeShortcut(["ctrl", "shift", "z"])).toEqual({ modifiers: 10, key: "z" });
  });

  it("maps special and punctuation keys to CDP definitions", () => {
    expect(keyDefinition("Enter")).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    expect(keyDefinition("?")).toMatchObject({ key: "?", code: "Slash", windowsVirtualKeyCode: 191 });
    expect(keyDefinition("A")).toMatchObject({ code: "KeyA", windowsVirtualKeyCode: 65 });
  });

  it("adds editing commands for command shortcuts", () => {
    expect(editingCommands("a", 4)).toEqual(["SelectAll"]);
    expect(editingCommands("z", 12)).toEqual(["Redo"]);
    expect(editingCommands("c", 0)).toEqual([]);
  });

  it("builds rawKeyDown/keyUp pairs without typing shortcut text", () => {
    const events = keyEvents(["Meta", "v"]);
    expect(events.down).toMatchObject({
      type: "rawKeyDown",
      modifiers: 4,
      key: "v",
      code: "KeyV",
      commands: ["Paste"],
    });
    expect(events.down).not.toHaveProperty("text");
    expect(events.up).toMatchObject({ type: "keyUp", modifiers: 4, key: "v", code: "KeyV" });
  });

  it("rejects ambiguous multi-key shortcuts", () => {
    expect(() => normalizeShortcut(["a", "b"])).toThrow(/exactly one non-modifier/);
  });
});
