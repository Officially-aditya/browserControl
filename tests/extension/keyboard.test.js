import { describe, expect, it } from "vitest";
import { editingCommands, isPasteShortcut, keyDefinition, keyEvents, normalizeShortcut } from "../../extension/keyboard.js";

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

  it("adds editing commands for command shortcuts and excludes Paste", () => {
    expect(editingCommands("a", 4)).toEqual(["SelectAll"]);
    expect(editingCommands("c", 4)).toEqual(["Copy"]);
    expect(editingCommands("v", 4)).toEqual([]);
    expect(editingCommands("z", 12)).toEqual(["Redo"]);
    expect(editingCommands("c", 0)).toEqual([]);
  });

  it("builds rawKeyDown/keyUp pairs without typing shortcut text", () => {
    const events = keyEvents(["Meta", "c"]);
    expect(events.down).toMatchObject({
      type: "rawKeyDown",
      modifiers: 4,
      key: "c",
      code: "KeyC",
      commands: ["Copy"],
    });
    expect(events.down).not.toHaveProperty("text");
    expect(events.up).toMatchObject({ type: "keyUp", modifiers: 4, key: "c", code: "KeyC" });
  });

  it("identifies and blocks paste shortcuts to enforce keyboard typing", () => {
    expect(isPasteShortcut(["Meta", "v"])).toBe(true);
    expect(isPasteShortcut(["ctrl", "v"])).toBe(true);
    expect(isPasteShortcut(["paste"])).toBe(true);
    expect(isPasteShortcut(["cmd", "c"])).toBe(false);
    expect(isPasteShortcut(["v"])).toBe(false);

    expect(() => normalizeShortcut(["Meta", "v"])).toThrow(/Pasting via keyboard shortcut is disabled/);
    expect(() => keyEvents(["Control", "v"])).toThrow(/Pasting via keyboard shortcut is disabled/);
  });

  it("rejects ambiguous multi-key shortcuts", () => {
    expect(() => normalizeShortcut(["a", "b"])).toThrow(/exactly one non-modifier/);
  });
});
