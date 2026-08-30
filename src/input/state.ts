import { MouseButton } from "../protocol/actions.js";

export const MODIFIERS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
} as const;

export const BUTTON_BITS: Record<MouseButton, number> = {
  left: 1,
  right: 2,
  middle: 4,
  back: 8,
  forward: 16,
};

export class InputStateManager {
  private _pressedKeys = new Set<string>();
  private _modifierBitmask = 0;
  private _pressedButtons = new Set<MouseButton>();
  private _buttonsBitmask = 0;
  private _cursorX = 0;
  private _cursorY = 0;

  public get pressedKeys(): ReadonlySet<string> {
    return this._pressedKeys;
  }

  public get modifierBitmask(): number {
    return this._modifierBitmask;
  }

  public get pressedButtons(): ReadonlySet<MouseButton> {
    return this._pressedButtons;
  }

  public get buttonsBitmask(): number {
    return this._buttonsBitmask;
  }

  public get cursorX(): number {
    return this._cursorX;
  }

  public get cursorY(): number {
    return this._cursorY;
  }

  public setCursorPosition(x: number, y: number): void {
    this._cursorX = x;
    this._cursorY = y;
  }

  public parseModifierArray(keys: string[]): number {
    let bitmask = 0;
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
      }
    }
    return bitmask;
  }

  public getEffectiveModifiers(explicitModifiers?: number | string[]): number {
    let extra = 0;
    if (typeof explicitModifiers === "number") {
      extra = explicitModifiers;
    } else if (Array.isArray(explicitModifiers)) {
      extra = this.parseModifierArray(explicitModifiers);
    }
    return this._modifierBitmask | extra;
  }

  public setKeyDown(key: string): void {
    this._pressedKeys.add(key);
    const lower = key.toLowerCase();
    if (lower === "shift") {
      this._modifierBitmask |= MODIFIERS.Shift;
    } else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super") {
      this._modifierBitmask |= MODIFIERS.Meta;
    } else if (lower === "control" || lower === "ctrl") {
      this._modifierBitmask |= MODIFIERS.Control;
    } else if (lower === "alt" || lower === "option") {
      this._modifierBitmask |= MODIFIERS.Alt;
    }
  }

  public setKeyUp(key: string): void {
    this._pressedKeys.delete(key);
    const lower = key.toLowerCase();
    if (lower === "shift") {
      this._modifierBitmask &= ~MODIFIERS.Shift;
    } else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super") {
      this._modifierBitmask &= ~MODIFIERS.Meta;
    } else if (lower === "control" || lower === "ctrl") {
      this._modifierBitmask &= ~MODIFIERS.Control;
    } else if (lower === "alt" || lower === "option") {
      this._modifierBitmask &= ~MODIFIERS.Alt;
    }
  }

  public setMouseDown(button: MouseButton): void {
    this._pressedButtons.add(button);
    const bit = BUTTON_BITS[button] || 1;
    this._buttonsBitmask |= bit;
  }

  public setMouseUp(button: MouseButton): void {
    this._pressedButtons.delete(button);
    const bit = BUTTON_BITS[button] || 1;
    this._buttonsBitmask &= ~bit;
  }

  public reset(): { releasedKeys: string[]; releasedButtons: MouseButton[] } {
    const releasedKeys = Array.from(this._pressedKeys);
    const releasedButtons = Array.from(this._pressedButtons);

    this._pressedKeys.clear();
    this._modifierBitmask = 0;
    this._pressedButtons.clear();
    this._buttonsBitmask = 0;

    return { releasedKeys, releasedButtons };
  }
}
