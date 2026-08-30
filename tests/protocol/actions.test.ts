import { describe, it, expect } from "vitest";
import {
  ComputerActionSchema,
  BrowserActionSchema,
} from "../../src/protocol/actions.js";

describe("Protocol Action Schemas", () => {
  it("should validate screenshot action", () => {
    const res = ComputerActionSchema.safeParse({ type: "screenshot" });
    expect(res.success).toBe(true);
  });

  it("should validate move action with required observationId", () => {
    const valid = ComputerActionSchema.safeParse({
      type: "move",
      observationId: "obs_123",
      x: 120,
      y: 340,
    });
    expect(valid.success).toBe(true);

    const invalid = ComputerActionSchema.safeParse({
      type: "move",
      x: 120,
      y: 340,
    });
    expect(invalid.success).toBe(false);
  });

  it("should validate click action with observationId and options", () => {
    const res1 = ComputerActionSchema.safeParse({
      type: "click",
      observationId: "obs_123",
      x: 50,
      y: 80,
    });
    expect(res1.success).toBe(true);
    if (res1.success && res1.data.type === "click") {
      expect(res1.data.button).toBe("left");
    }

    const res2 = ComputerActionSchema.safeParse({
      type: "click",
      observationId: "obs_123",
      x: 50,
      y: 80,
      button: "right",
      modifiers: ["Meta"],
    });
    expect(res2.success).toBe(true);
    if (res2.success && res2.data.type === "click") {
      expect(res2.data.button).toBe("right");
    }
  });

  it("should validate drag action with coordinate path", () => {
    const valid = ComputerActionSchema.safeParse({
      type: "drag",
      observationId: "obs_123",
      path: [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
        { x: 300, y: 300 },
      ],
    });
    expect(valid.success).toBe(true);

    const invalid = ComputerActionSchema.safeParse({
      type: "drag",
      observationId: "obs_123",
      path: [{ x: 100, y: 100 }], // Must have >= 2 points
    });
    expect(invalid.success).toBe(false);
  });

  it("should validate keypress, key_down, key_up, and reset_input actions", () => {
    expect(ComputerActionSchema.safeParse({ type: "keypress", keys: ["Meta", "A"] }).success).toBe(true);
    expect(ComputerActionSchema.safeParse({ type: "key_down", key: "Shift" }).success).toBe(true);
    expect(ComputerActionSchema.safeParse({ type: "key_up", key: "Shift" }).success).toBe(true);
    expect(ComputerActionSchema.safeParse({ type: "reset_input" }).success).toBe(true);
  });

  it("should validate type action with method options", () => {
    const resAuto = ComputerActionSchema.safeParse({
      type: "type",
      text: "hello world",
      method: "auto",
    });
    expect(resAuto.success).toBe(true);

    const resKeyEvents = ComputerActionSchema.safeParse({
      type: "type",
      text: "hello world",
      method: "key_events",
    });
    expect(resKeyEvents.success).toBe(true);
  });

  it("should validate browser actions including windows and dialogs", () => {
    expect(BrowserActionSchema.safeParse({ type: "navigate", url: "https://github.com" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "back" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "forward" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "reload" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "tabs" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "windows" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "new_window", url: "https://example.com" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "activate_window", windowId: 1 }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "close_window", windowId: 1 }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "dialog_state" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "handle_dialog", accept: true, promptText: "Green" }).success).toBe(true);
  });
});
