import { TabSession } from "../chrome/session.js";
import { TypingMethod } from "../protocol/actions.js";
import { InputStateManager, MODIFIERS } from "./state.js";

export interface KeyDefinition {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const SPECIAL_KEYS: Record<string, KeyDefinition> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  f1: { key: "F1", code: "F1", windowsVirtualKeyCode: 112 },
  f2: { key: "F2", code: "F2", windowsVirtualKeyCode: 113 },
  f3: { key: "F3", code: "F3", windowsVirtualKeyCode: 114 },
  f4: { key: "F4", code: "F4", windowsVirtualKeyCode: 115 },
  f5: { key: "F5", code: "F5", windowsVirtualKeyCode: 116 },
  f6: { key: "F6", code: "F6", windowsVirtualKeyCode: 117 },
  f7: { key: "F7", code: "F7", windowsVirtualKeyCode: 118 },
  f8: { key: "F8", code: "F8", windowsVirtualKeyCode: 119 },
  f9: { key: "F9", code: "F9", windowsVirtualKeyCode: 120 },
  f10: { key: "F10", code: "F10", windowsVirtualKeyCode: 121 },
  f11: { key: "F11", code: "F11", windowsVirtualKeyCode: 122 },
  f12: { key: "F12", code: "F12", windowsVirtualKeyCode: 123 },
  meta: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  cmd: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  command: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  super: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
  ctrl: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
  alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
  option: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
  shift: { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
};

const PUNCTUATION_MAP: Record<string, { code: string; keyCode: number; unshifted: string }> = {
  "-": { code: "Minus", keyCode: 189, unshifted: "-" },
  "_": { code: "Minus", keyCode: 189, unshifted: "-" },
  "=": { code: "Equal", keyCode: 187, unshifted: "=" },
  "+": { code: "Equal", keyCode: 187, unshifted: "=" },
  "[": { code: "BracketLeft", keyCode: 219, unshifted: "[" },
  "{": { code: "BracketLeft", keyCode: 219, unshifted: "[" },
  "]": { code: "BracketRight", keyCode: 221, unshifted: "]" },
  "}": { code: "BracketRight", keyCode: 221, unshifted: "]" },
  "\\": { code: "Backslash", keyCode: 220, unshifted: "\\" },
  "|": { code: "Backslash", keyCode: 220, unshifted: "\\" },
  ";": { code: "Semicolon", keyCode: 186, unshifted: ";" },
  ":": { code: "Semicolon", keyCode: 186, unshifted: ";" },
  "'": { code: "Quote", keyCode: 222, unshifted: "'" },
  "\"": { code: "Quote", keyCode: 222, unshifted: "'" },
  ",": { code: "Comma", keyCode: 188, unshifted: "," },
  "<": { code: "Comma", keyCode: 188, unshifted: "," },
  ".": { code: "Period", keyCode: 190, unshifted: "." },
  ">": { code: "Period", keyCode: 190, unshifted: "." },
  "/": { code: "Slash", keyCode: 191, unshifted: "/" },
  "?": { code: "Slash", keyCode: 191, unshifted: "/" },
  "`": { code: "Backquote", keyCode: 192, unshifted: "`" },
  "~": { code: "Backquote", keyCode: 192, unshifted: "`" },
};

export class KeyboardController {
  private session: TabSession;
  private inputState: InputStateManager;

  constructor(session: TabSession, inputState: InputStateManager) {
    this.session = session;
    this.inputState = inputState;
  }

  public parseModifiers(keys: string[]): { modifierBitmask: number; nonModifierKeys: string[] } {
    let bitmask = 0;
    const nonModifierKeys: string[] = [];

    for (const key of keys) {
      const lower = key.toLowerCase();
      if (lower === "alt" || lower === "option") {
        bitmask |= MODIFIERS.Alt;
      } else if (lower === "control" || lower === "ctrl") {
        bitmask |= MODIFIERS.Control;
      } else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super") {
        bitmask |= MODIFIERS.Meta;
      } else if (lower === "shift") {
        bitmask |= MODIFIERS.Shift;
      } else {
        nonModifierKeys.push(key);
      }
    }

    return { modifierBitmask: bitmask, nonModifierKeys };
  }

  public getKeyDefinition(keyStr: string): KeyDefinition {
    const lower = keyStr.toLowerCase();
    if (SPECIAL_KEYS[lower]) {
      return SPECIAL_KEYS[lower];
    }

    if (PUNCTUATION_MAP[keyStr]) {
      const p = PUNCTUATION_MAP[keyStr];
      return {
        key: keyStr,
        code: p.code,
        windowsVirtualKeyCode: p.keyCode,
        text: keyStr,
      };
    }

    if (keyStr.length === 1) {
      const char = keyStr;
      const upper = char.toUpperCase();
      const isLetter = (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
      const isDigit = char >= "0" && char <= "9";

      const code = isLetter
        ? `Key${upper}`
        : isDigit
        ? `Digit${char}`
        : "";

      return {
        key: char,
        code,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        text: char,
      };
    }

    return {
      key: keyStr,
      code: keyStr,
      windowsVirtualKeyCode: 0,
      text: keyStr,
    };
  }

  /**
   * Get editing command names for shortcuts (e.g. Meta+A -> SelectAll, Meta+C -> Copy)
   */
  private getEditingCommands(keyStr: string, hasCommandModifier: boolean, hasShift: boolean): string[] {
    if (!hasCommandModifier) return [];
    const lower = keyStr.toLowerCase();
    if (lower === "a") return ["SelectAll"];
    if (lower === "c") return ["Copy"];
    if (lower === "v") return ["Paste"];
    if (lower === "x") return ["Cut"];
    if (lower === "z") return hasShift ? ["Redo"] : ["Undo"];
    if (lower === "y") return ["Redo"];
    return [];
  }

  /**
   * Dispatch single key down and record into InputState
   */
  public async keyDown(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    this.inputState.setKeyDown(key);
    const modifiers = this.inputState.modifierBitmask;
    const def = this.getKeyDefinition(key);

    await this.session.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    });
  }

  /**
   * Dispatch single key up and remove from InputState
   */
  public async keyUp(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    const def = this.getKeyDefinition(key);
    const modifiers = this.inputState.modifierBitmask;
    this.inputState.setKeyUp(key);

    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    });
  }

  /**
   * Dispatch complete key combination / shortcut
   */
  public async keypress(keys: string[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");
    if (!keys.length) return;

    const { modifierBitmask, nonModifierKeys } = this.parseModifiers(keys);
    const effectiveModifiers = this.inputState.getEffectiveModifiers(modifierBitmask);

    if (nonModifierKeys.length === 0) {
      for (const key of keys) {
        await this.keyDown(key, signal);
        await new Promise((r) => setTimeout(r, 20));
        await this.keyUp(key, signal);
      }
      return;
    }

    const isMac = process.platform === "darwin";
    let platformAdjustedModifiers = effectiveModifiers;
    if (!isMac && (platformAdjustedModifiers & MODIFIERS.Meta)) {
      platformAdjustedModifiers = (platformAdjustedModifiers & ~MODIFIERS.Meta) | MODIFIERS.Control;
    }

    const hasCommandModifier = (platformAdjustedModifiers & (MODIFIERS.Meta | MODIFIERS.Control)) !== 0;
    const hasShift = (platformAdjustedModifiers & MODIFIERS.Shift) !== 0;

    for (const key of nonModifierKeys) {
      if (signal?.aborted) throw new Error("ACTION_CANCELLED");

      const def = this.getKeyDefinition(key);
      const commands = this.getEditingCommands(def.key, hasCommandModifier, hasShift);

      const keyParams: any = {
        type: "rawKeyDown",
        modifiers: platformAdjustedModifiers,
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.windowsVirtualKeyCode,
        text: def.text,
        unmodifiedText: def.text,
      };

      if (commands.length > 0) {
        keyParams.commands = commands;
      }

      await this.session.send("Input.dispatchKeyEvent", keyParams);

      if (def.text && !hasCommandModifier) {
        await this.session.send("Input.dispatchKeyEvent", {
          type: "char",
          modifiers: platformAdjustedModifiers,
          key: def.key,
          code: def.code,
          text: def.text,
          unmodifiedText: def.text,
        });
      }

      await new Promise((r) => setTimeout(r, 25));
      if (signal?.aborted) throw new Error("ACTION_CANCELLED");

      await this.session.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: platformAdjustedModifiers,
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      });
    }
  }

  /**
   * Type text using keyboard events or insertText
   * "auto" mode dispatches key events and insertText fallback for 100% universal support
   * across input, textarea, contenteditable, and canvas.
   */
  public async type(text: string, method: TypingMethod = "auto", signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");
    if (!text) return;

    if (method === "insert_text") {
      await this.session.send("Input.insertText", { text });
      return;
    }

    const chars = Array.from(text);

    if (method === "key_events") {
      for (const char of chars) {
        if (signal?.aborted) throw new Error("ACTION_CANCELLED");

        if (char === "\n") {
          await this.keypress(["Enter"], signal);
        } else if (char === "\t") {
          await this.keypress(["Tab"], signal);
        } else {
          const def = this.getKeyDefinition(char);
          const isUpperCase = char >= "A" && char <= "Z";
          const charModifiers = isUpperCase ? (this.inputState.modifierBitmask | MODIFIERS.Shift) : this.inputState.modifierBitmask;

          await this.session.send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            modifiers: charModifiers,
            key: def.key,
            code: def.code,
            windowsVirtualKeyCode: def.windowsVirtualKeyCode,
            text: char,
            unmodifiedText: char,
          });

          await this.session.send("Input.dispatchKeyEvent", {
            type: "char",
            modifiers: charModifiers,
            key: def.key,
            code: def.code,
            text: char,
            unmodifiedText: char,
          });

          await this.session.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            modifiers: charModifiers,
            key: def.key,
            code: def.code,
            windowsVirtualKeyCode: def.windowsVirtualKeyCode,
          });
        }

        if (chars.length > 1) {
          await new Promise((r) => setTimeout(r, 8));
        }
      }
      return;
    }

    // Default "auto": dispatches keydown events + insertText to guarantee compatibility
    // with both DOM inputs (input/textarea/contenteditable) and canvas listeners
    for (const char of chars) {
      if (signal?.aborted) throw new Error("ACTION_CANCELLED");

      if (char === "\n") {
        await this.keypress(["Enter"], signal);
      } else if (char === "\t") {
        await this.keypress(["Tab"], signal);
      } else {
        const def = this.getKeyDefinition(char);
        const isUpperCase = char >= "A" && char <= "Z";
        const charModifiers = isUpperCase ? (this.inputState.modifierBitmask | MODIFIERS.Shift) : this.inputState.modifierBitmask;

        // 1. Dispatch key event for listeners
        await this.session.send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          modifiers: charModifiers,
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.windowsVirtualKeyCode,
          text: char,
          unmodifiedText: char,
        });

        // 2. Insert text character
        await this.session.send("Input.insertText", { text: char });

        // 3. Dispatch keyUp
        await this.session.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          modifiers: charModifiers,
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.windowsVirtualKeyCode,
        });
      }

      if (chars.length > 1) {
        await new Promise((r) => setTimeout(r, 6));
      }
    }
  }

  /**
   * Reset all held keyboard keys without affecting mouse state
   */
  public async reset(): Promise<void> {
    const { releasedKeys } = this.inputState.resetKeyboard();
    for (const key of releasedKeys) {
      try {
        const def = this.getKeyDefinition(key);
        await this.session.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          modifiers: 0,
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.windowsVirtualKeyCode,
        });
      } catch {}
    }
  }
}
