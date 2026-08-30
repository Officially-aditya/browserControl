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

  it("should validate move action", () => {
    const res = ComputerActionSchema.safeParse({ type: "move", x: 120, y: 340 });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.x).toBe(120);
      expect(res.data.y).toBe(340);
    }
  });

  it("should validate click action with defaults and options", () => {
    const res1 = ComputerActionSchema.safeParse({ type: "click", x: 50, y: 80 });
    expect(res1.success).toBe(true);
    if (res1.success && res1.data.type === "click") {
      expect(res1.data.button).toBe("left");
    }

    const res2 = ComputerActionSchema.safeParse({ type: "click", x: 50, y: 80, button: "right" });
    expect(res2.success).toBe(true);
    if (res2.success && res2.data.type === "click") {
      expect(res2.data.button).toBe("right");
    }
  });

  it("should validate drag action with coordinate path", () => {
    const valid = ComputerActionSchema.safeParse({
      type: "drag",
      path: [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
        { x: 300, y: 300 },
      ],
    });
    expect(valid.success).toBe(true);

    const invalid = ComputerActionSchema.safeParse({
      type: "drag",
      path: [{ x: 100, y: 100 }], // Must have >= 2 points
    });
    expect(invalid.success).toBe(false);
  });

  it("should validate keypress action", () => {
    const res = ComputerActionSchema.safeParse({
      type: "keypress",
      keys: ["Meta", "A"],
    });
    expect(res.success).toBe(true);
  });

  it("should validate type action", () => {
    const res = ComputerActionSchema.safeParse({
      type: "type",
      text: "hello world",
    });
    expect(res.success).toBe(true);
  });

  it("should validate browser actions", () => {
    expect(BrowserActionSchema.safeParse({ type: "navigate", url: "https://github.com" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "back" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "forward" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "reload" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "tabs" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "switch_tab", targetId: "target-123" }).success).toBe(true);
    expect(BrowserActionSchema.safeParse({ type: "close_tab", targetId: "target-123" }).success).toBe(true);
  });
});
