const MODIFIERS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

const MODIFIER_ALIASES = new Map([
  ["alt", "Alt"],
  ["option", "Alt"],
  ["control", "Control"],
  ["ctrl", "Control"],
  ["meta", "Meta"],
  ["cmd", "Meta"],
  ["command", "Meta"],
  ["super", "Meta"],
  ["shift", "Shift"],
]);

const SPECIAL_KEYS = {
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
};

const PUNCTUATION = {
  "-": ["Minus", 189], "_": ["Minus", 189],
  "=": ["Equal", 187], "+": ["Equal", 187],
  "[": ["BracketLeft", 219], "{": ["BracketLeft", 219],
  "]": ["BracketRight", 221], "}": ["BracketRight", 221],
  "\\": ["Backslash", 220], "|": ["Backslash", 220],
  ";": ["Semicolon", 186], ":": ["Semicolon", 186],
  "'": ["Quote", 222], "\"": ["Quote", 222],
  ",": ["Comma", 188], "<": ["Comma", 188],
  ".": ["Period", 190], ">": ["Period", 190],
  "/": ["Slash", 191], "?": ["Slash", 191],
  "`": ["Backquote", 192], "~": ["Backquote", 192],
};

export function normalizeShortcut(keys) {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("keys is required");
  let modifiers = 0;
  const nonModifiers = [];
  for (const raw of keys) {
    const key = String(raw);
    const canonical = MODIFIER_ALIASES.get(key.toLowerCase());
    if (canonical) modifiers |= MODIFIERS[canonical];
    else nonModifiers.push(key);
  }
  if (nonModifiers.length !== 1) throw new Error("keypress requires exactly one non-modifier key");
  return { modifiers, key: nonModifiers[0] };
}

export function keyDefinition(key) {
  const value = String(key);
  const special = SPECIAL_KEYS[value.toLowerCase()];
  if (special) return { ...special };

  const punctuation = PUNCTUATION[value];
  if (punctuation) {
    return { key: value, code: punctuation[0], windowsVirtualKeyCode: punctuation[1], text: value };
  }

  if (value.length === 1) {
    const upper = value.toUpperCase();
    const isLetter = /^[A-Za-z]$/.test(value);
    const isDigit = /^\d$/.test(value);
    return {
      key: value,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${value}` : "",
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: value,
    };
  }

  return { key: value, code: value, windowsVirtualKeyCode: 0 };
}

export function editingCommands(key, modifiers) {
  const hasCommand = Boolean(modifiers & (MODIFIERS.Meta | MODIFIERS.Control));
  if (!hasCommand) return [];
  const lower = String(key).toLowerCase();
  if (lower === "a") return ["SelectAll"];
  if (lower === "c") return ["Copy"];
  if (lower === "v") return ["Paste"];
  if (lower === "x") return ["Cut"];
  if (lower === "z") return modifiers & MODIFIERS.Shift ? ["Redo"] : ["Undo"];
  if (lower === "y") return ["Redo"];
  return [];
}

export function keyEvents(keys) {
  const { modifiers, key } = normalizeShortcut(keys);
  const def = keyDefinition(key);
  const commands = editingCommands(key, modifiers);
  const suppressText = Boolean(modifiers & (MODIFIERS.Meta | MODIFIERS.Control | MODIFIERS.Alt));
  return {
    down: {
      type: "rawKeyDown",
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      ...(commands.length ? { commands } : {}),
      ...(!suppressText && def.text ? { text: def.text } : {}),
    },
    up: {
      type: "keyUp",
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    },
  };
}
