import { TabSession } from "../chrome/session.js";
import { Coordinate } from "../protocol/actions.js";
import { InputStateManager } from "./state.js";

export class DragController {
  private session: TabSession;
  private inputState: InputStateManager;

  constructor(session: TabSession, inputState: InputStateManager) {
    this.session = session;
    this.inputState = inputState;
  }

  /**
   * Execute smooth path-based drag-and-drop
   */
  public async drag(path: Coordinate[], explicitModifiers = 0, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");
    if (path.length < 2) {
      throw new Error("Drag requires at least start and end coordinates");
    }

    const modifiers = this.inputState.getEffectiveModifiers(explicitModifiers);
    const start = path[0];

    // 1. Move to starting position
    this.inputState.setCursorPosition(start.x, start.y);
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x,
      y: start.y,
      button: "none",
      buttons: this.inputState.buttonsBitmask,
      modifiers,
    });

    await new Promise((r) => setTimeout(r, 40));
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    // 2. Press left mouse button down
    this.inputState.setMouseDown("left");
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: start.x,
      y: start.y,
      button: "left",
      buttons: this.inputState.buttonsBitmask,
      clickCount: 1,
      modifiers,
    });

    await new Promise((r) => setTimeout(r, 40));
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    // 3. Move through path waypoints with smooth intermediate steps
    for (let i = 1; i < path.length; i++) {
      if (signal?.aborted) throw new Error("ACTION_CANCELLED");

      const prev = path[i - 1];
      const target = path[i];

      const dx = target.x - prev.x;
      const dy = target.y - prev.y;
      const distance = Math.hypot(dx, dy);
      const subSteps = Math.max(1, Math.ceil(distance / 20));

      for (let s = 1; s <= subSteps; s++) {
        if (signal?.aborted) throw new Error("ACTION_CANCELLED");

        const stepX = prev.x + (dx * s) / subSteps;
        const stepY = prev.y + (dy * s) / subSteps;
        const roundX = Math.round(stepX * 100) / 100;
        const roundY = Math.round(stepY * 100) / 100;

        this.inputState.setCursorPosition(roundX, roundY);
        await this.session.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: roundX,
          y: roundY,
          button: "left",
          buttons: this.inputState.buttonsBitmask,
          modifiers,
        });

        await new Promise((r) => setTimeout(r, 10));
      }
    }

    const end = path[path.length - 1];

    await new Promise((r) => setTimeout(r, 40));
    if (signal?.aborted) throw new Error("ACTION_CANCELLED");

    // 4. Release mouse button at destination
    this.inputState.setMouseUp("left");
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: end.x,
      y: end.y,
      button: "left",
      buttons: this.inputState.buttonsBitmask,
      clickCount: 1,
      modifiers,
    });
  }
}
