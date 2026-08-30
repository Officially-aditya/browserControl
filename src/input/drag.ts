import { TabSession } from "../chrome/session.js";
import { Coordinate } from "../protocol/actions.js";

export class DragController {
  private session: TabSession;

  constructor(session: TabSession) {
    this.session = session;
  }

  /**
   * Execute smooth path-based drag-and-drop
   */
  public async drag(path: Coordinate[], modifiers = 0): Promise<void> {
    if (path.length < 2) {
      throw new Error("Drag requires at least start and end coordinates");
    }

    const start = path[0];

    // 1. Move to starting position
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x,
      y: start.y,
      button: "none",
      modifiers,
    });

    await new Promise((r) => setTimeout(r, 40));

    // 2. Press left mouse button down
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: start.x,
      y: start.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers,
    });

    await new Promise((r) => setTimeout(r, 40));

    // 3. Move through path waypoints with smooth intermediate steps
    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1];
      const target = path[i];

      const dx = target.x - prev.x;
      const dy = target.y - prev.y;
      const distance = Math.hypot(dx, dy);
      const subSteps = Math.max(1, Math.ceil(distance / 20));

      for (let s = 1; s <= subSteps; s++) {
        const stepX = prev.x + (dx * s) / subSteps;
        const stepY = prev.y + (dy * s) / subSteps;

        await this.session.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(stepX * 100) / 100,
          y: Math.round(stepY * 100) / 100,
          button: "left",
          buttons: 1,
          modifiers,
        });

        await new Promise((r) => setTimeout(r, 10));
      }
    }

    const end = path[path.length - 1];

    await new Promise((r) => setTimeout(r, 40));

    // 4. Release mouse button at destination
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: end.x,
      y: end.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      modifiers,
    });
  }
}
