import { TabSession } from "../chrome/session.js";
import { TypingMethod } from "../protocol/actions.js";

// CDP Modifier bitflags
export const MODIFIERS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
} as const;

export interface KeyDefinition {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  shiftKey?: string;
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

  constructor(session: TabSession) {
    this.session = session;
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
      const isLetter = char >= "a" && char <= "z" || (char >= "A" && char <= "Z");
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
    };
  }

  /**
   * Dispatch single key down
   */
  public async keyDown(key: string, modifiers = 0): Promise<void> {
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
   * Dispatch single key up
   */
  public async keyUp(key: string, modifiers = 0): Promise<void> {
    const def = this.getKeyDefinition(key);
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
  public async keypress(keys: string[]): Promise<void> {
    if (!keys.length) return;

    const { modifierBitmask, nonModifierKeys } = this.parseModifiers(keys);

    if (nonModifierKeys.length === 0) {
      for (const key of keys) {
        await this.keyDown(key, modifierBitmask);
        await new Promise((r) => setTimeout(r, 20));
        await this.keyUp(key, 0);
      }
      return;
    }

    const isMac = process.platform === "darwin";
    let effectiveModifiers = modifierBitmask;
    if (!isMac && (effectiveModifiers & MODIFIERS.Meta)) {
      effectiveModifiers = (effectiveModifiers & ~MODIFIERS.Meta) | MODIFIERS.Control;
    }

    for (const key of nonModifierKeys) {
      const def = this.getKeyDefinition(key);

      await this.session.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        modifiers: effectiveModifiers,
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.windowsVirtualKeyCode,
        text: def.text,
        unmodifiedText: def.text,
      });

      // Only dispatch 'char' event if no command modifiers (Cmd/Ctrl) are active
      const hasCommandModifier = (effectiveModifiers & (MODIFIERS.Meta | MODIFIERS.Control)) !== 0;
      if (def.text && !hasCommandModifier) {
        await this.session.send("Input.dispatchKeyEvent", {
          type: "char",
          modifiers: effectiveModifiers,
          key: def.key,
          code: def.code,
          text: def.text,
          unmodifiedText: def.text,
        });
      }

      await new Promise((r) => setTimeout(r, 25));

      await this.session.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: effectiveModifiers,
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      });
    }
  }

  /**
   * Insert or type text using either insertText or sequence of key events
   */
  public async type(text: string, method: TypingMethod = "auto"): Promise<void> {
    if (!text) return;

    if (method === "insert_text" || method === "auto") {
      await this.session.send("Input.insertText", { text });
      return;
    }

    // method === "key_events" (Local rapid event dispatch for canvas/custom input listeners)
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === "\n") {
        await this.keypress(["Enter"]);
      } else if (char === "\t") {
        await this.keypress(["Tab"]);
      } else {
        const def = this.getKeyDefinition(char);
        const isUpperCase = char >= "A" && char <= "Z";
        const modifiers = isUpperCase ? MODIFIERS.Shift : 0;

        await this.session.send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          modifiers,
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.windowsVirtualKeyCode,
          text: char,
          unmodifiedText: char,
        });

        await this.session.send("Input.dispatchKeyEvent", {
          type: "char",
          modifiers,
          key: def.key,
          code: def.code,
          text: char,
          unmodifiedText: char,
        });

        await this.session.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          modifiers,
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.windowsVirtualKeyCode,
        });
      }

      if (text.length > 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  }
}
