import { TabSession } from "../chrome/session.js";
import { MouseButton } from "../protocol/actions.js";

const BUTTON_BITS: Record<MouseButton, number> = {
  left: 1,
  right: 2,
  middle: 4,
  back: 8,
  forward: 16,
};

export class MouseController {
  private session: TabSession;
  private currentX = 0;
  private currentY = 0;

  constructor(session: TabSession) {
    this.session = session;
  }

  public get position(): { x: number; y: number } {
    return { x: this.currentX, y: this.currentY };
  }

  /**
   * Dispatch mouse movement
   */
  public async move(x: number, y: number, modifiers = 0): Promise<void> {
    this.currentX = x;
    this.currentY = y;

    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      modifiers,
    });
  }

  /**
   * Dispatch mouse click
   */
  public async click(x: number, y: number, button: MouseButton = "left", modifiers = 0): Promise<void> {
    this.currentX = x;
    this.currentY = y;
    const buttonBit = BUTTON_BITS[button] || 1;

    // 1. Move to coordinate
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      modifiers,
    });

    // 2. Press mouse button
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: buttonBit,
      clickCount: 1,
      modifiers,
    });

    // Tactile click duration
    await new Promise((r) => setTimeout(r, 40));

    // 3. Release mouse button
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1,
      modifiers,
    });
  }

  /**
   * Dispatch double click
   */
  public async doubleClick(x: number, y: number, button: MouseButton = "left", modifiers = 0): Promise<void> {
    this.currentX = x;
    this.currentY = y;
    const buttonBit = BUTTON_BITS[button] || 1;

    // Move
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      modifiers,
    });

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
   * Mouse down
   */
  public async down(x: number, y: number, button: MouseButton = "left", modifiers = 0): Promise<void> {
    this.currentX = x;
    this.currentY = y;
    const buttonBit = BUTTON_BITS[button] || 1;

    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: buttonBit,
      clickCount: 1,
      modifiers,
    });
  }

  /**
   * Mouse up
   */
  public async up(x: number, y: number, button: MouseButton = "left", modifiers = 0): Promise<void> {
    this.currentX = x;
    this.currentY = y;

    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1,
      modifiers,
    });
  }

  /**
   * Dispatch mouse wheel scroll
   */
  public async scroll(x: number, y: number, deltaX = 0, deltaY = 0, modifiers = 0): Promise<void> {
    this.currentX = x;
    this.currentY = y;

    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      modifiers,
    });

    const maxChunk = 120;
    const steps = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / maxChunk)
    );

    const stepX = deltaX / steps;
    const stepY = deltaY / steps;

    for (let i = 0; i < steps; i++) {
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
}
