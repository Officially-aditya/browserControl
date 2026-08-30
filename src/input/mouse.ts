import { TabSession } from "../chrome/session.js";
import { MouseButton } from "../protocol/actions.js";
import { InputStateManager, BUTTON_BITS } from "./state.js";

export class MouseController {
  private session: TabSession;
  private inputState: InputStateManager;

  constructor(session: TabSession, inputState: InputStateManager) {
    this.session = session;
    this.inputState = inputState;
  }

  public get position(): { x: number; y: number } {
    return { x: this.inputState.cursorX, y: this.inputState.cursorY };
  }

  /**
   * Dispatch mouse movement
   */
  public async move(x: number, y: number, explicitModifiers = 0, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    this.inputState.setCursorPosition(x, y);
    const modifiers = this.inputState.getEffectiveModifiers(explicitModifiers);
    const buttons = this.inputState.buttonsBitmask;

    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons,
      modifiers,
    });
  }

  /**
   * Mouse down
   */
  public async down(
    x: number,
    y: number,
    button: MouseButton = "left",
    explicitModifiers = 0,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    this.inputState.setCursorPosition(x, y);
    this.inputState.setMouseDown(button);
    const modifiers = this.inputState.getEffectiveModifiers(explicitModifiers);
    const buttons = this.inputState.buttonsBitmask;

    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons,
      clickCount: 1,
      modifiers,
    });
  }

  /**
   * Mouse up
   */
  public async up(
    x: number,
    y: number,
    button: MouseButton = "left",
    explicitModifiers = 0,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    this.inputState.setCursorPosition(x, y);
    this.inputState.setMouseUp(button);
    const modifiers = this.inputState.getEffectiveModifiers(explicitModifiers);
    const buttons = this.inputState.buttonsBitmask;

    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons,
      clickCount: 1,
      modifiers,
    });
  }

  /**
   * Dispatch mouse click
   */
  public async click(
    x: number,
    y: number,
    button: MouseButton = "left",
    explicitModifiers = 0,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    await this.move(x, y, explicitModifiers, signal);
    await this.down(x, y, button, explicitModifiers, signal);

    await new Promise((r) => setTimeout(r, 40));
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    await this.up(x, y, button, explicitModifiers, signal);
  }

  /**
   * Dispatch double click
   */
  public async doubleClick(
    x: number,
    y: number,
    button: MouseButton = "left",
    explicitModifiers = 0,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    this.inputState.setCursorPosition(x, y);
    const modifiers = this.inputState.getEffectiveModifiers(explicitModifiers);
    const buttonBit = BUTTON_BITS[button] || 1;

    // Move
    await this.move(x, y, explicitModifiers, signal);

    // Click 1
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: buttonBit,
      clickCount: 1,
      modifiers,
    });
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1,
      modifiers,
    });

    await new Promise((r) => setTimeout(r, 50));
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    // Click 2
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: buttonBit,
      clickCount: 2,
      modifiers,
    });
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: 2,
      modifiers,
    });
  }

  /**
   * Dispatch mouse wheel scroll
   */
  public async scroll(
    x: number,
    y: number,
    deltaX = 0,
    deltaY = 0,
    explicitModifiers = 0,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    await this.move(x, y, explicitModifiers, signal);
    const modifiers = this.inputState.getEffectiveModifiers(explicitModifiers);

    const maxChunk = 120;
    const steps = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / maxChunk)
    );

    const stepX = deltaX / steps;
    const stepY = deltaY / steps;

    for (let i = 0; i < steps; i++) {
      if (signal?.aborted) throw new Error("ACTION_CANCELLED");

      await this.session.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: stepX,
        deltaY: stepY,
        modifiers,
      });

      if (steps > 1 && i < steps - 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }

  /**
   * Emergency reset for mouse buttons and dragging
   */
  public async reset(): Promise<void> {
    try {
      await this.session.send("Input.cancelDragging", {});
    } catch {}

    const { releasedButtons } = this.inputState.reset();
    for (const btn of releasedButtons) {
      try {
        await this.session.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: this.inputState.cursorX,
          y: this.inputState.cursorY,
          button: btn,
          buttons: 0,
          clickCount: 1,
        });
      } catch {}
    }
  }
}
