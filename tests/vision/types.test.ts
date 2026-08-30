import { describe, it, expect } from "vitest";
import {
  NormalizedCoordinateSchema,
  NormalizedRegionSchema,
  VisionDecisionSchema,
  NormalizedComputerActionSchema,
  NormalizedBrowserActionSchema,
} from "../../src/vision/types.js";
import {
  validateVisionDecision,
  safeValidateVisionDecision,
} from "../../src/vision/adapter.js";

describe("Vision Protocol & Decision Schemas", () => {
  describe("1. Normalized Coordinate Bounds (0-1000)", () => {
    it("should accept valid coordinates inside [0, 1000]", () => {
      expect(NormalizedCoordinateSchema.safeParse({ x: 0, y: 0 }).success).toBe(true);
      expect(NormalizedCoordinateSchema.safeParse({ x: 500, y: 500 }).success).toBe(true);
      expect(NormalizedCoordinateSchema.safeParse({ x: 1000, y: 1000 }).success).toBe(true);
      expect(NormalizedCoordinateSchema.safeParse({ x: 724.5, y: 418.2 }).success).toBe(true);
    });

    it("should reject negative or overflowing coordinates", () => {
      expect(NormalizedCoordinateSchema.safeParse({ x: -1, y: 500 }).success).toBe(false);
      expect(NormalizedCoordinateSchema.safeParse({ x: 500, y: -0.1 }).success).toBe(false);
      expect(NormalizedCoordinateSchema.safeParse({ x: 1001, y: 500 }).success).toBe(false);
      expect(NormalizedCoordinateSchema.safeParse({ x: 500, y: 1000.5 }).success).toBe(false);
    });
  });

  describe("2. Normalized Region Validation", () => {
    it("should accept regions within 0-1000 bounds", () => {
      const validRegion = { x: 450, y: 300, width: 350, height: 250 };
      expect(NormalizedRegionSchema.safeParse(validRegion).success).toBe(true);

      const fullRegion = { x: 0, y: 0, width: 1000, height: 1000 };
      expect(NormalizedRegionSchema.safeParse(fullRegion).success).toBe(true);
    });

    it("should reject regions extending beyond 1000 boundary", () => {
      // x + width = 1001
      const overflowX = { x: 700, y: 200, width: 301, height: 200 };
      expect(NormalizedRegionSchema.safeParse(overflowX).success).toBe(false);

      // y + height = 1050
      const overflowY = { x: 100, y: 800, width: 200, height: 250 };
      expect(NormalizedRegionSchema.safeParse(overflowY).success).toBe(false);

      // Zero or negative dimensions
      expect(NormalizedRegionSchema.safeParse({ x: 100, y: 100, width: 0, height: 100 }).success).toBe(false);
      expect(NormalizedRegionSchema.safeParse({ x: 100, y: 100, width: 100, height: -50 }).success).toBe(false);
    });
  });

  describe("3. Decision Types Validation", () => {
    it("should validate inspect_region decision", () => {
      const decision = {
        type: "inspect_region",
        region: { x: 450, y: 300, width: 350, height: 250 },
        certainty: "uncertain",
        reasoning: "Button label unclear at current resolution",
      };

      const parsed = validateVisionDecision(decision);
      expect(parsed.type).toBe("inspect_region");
      if (parsed.type === "inspect_region") {
        expect(parsed.region.x).toBe(450);
        expect(parsed.certainty).toBe("uncertain");
      }
    });

    it("should validate computer_action decision (click, type, drag, etc.)", () => {
      const clickDecision = {
        type: "computer_action",
        action: {
          type: "click",
          x: 724,
          y: 418,
          button: "left",
        },
        certainty: "certain",
        intent: "open settings",
      };
      const parsedClick = validateVisionDecision(clickDecision);
      expect(parsedClick.type).toBe("computer_action");

      const dragDecision = {
        type: "computer_action",
        action: {
          type: "drag",
          path: [
            { x: 100, y: 200 },
            { x: 500, y: 200 },
          ],
        },
        certainty: "likely",
      };
      const parsedDrag = validateVisionDecision(dragDecision);
      expect(parsedDrag.type).toBe("computer_action");
    });

    it("should validate browser_action decision (navigate, tabs, dialogs)", () => {
      const navDecision = {
        type: "browser_action",
        action: {
          type: "navigate",
          url: "https://example.com",
        },
        certainty: "certain",
        intent: "navigate to home",
      };
      const parsed = validateVisionDecision(navDecision);
      expect(parsed.type).toBe("browser_action");
    });

    it("should validate done decision", () => {
      const doneDecision = {
        type: "done",
        result: "Task completed successfully",
        success: true,
        certainty: "certain",
      };
      const parsed = validateVisionDecision(doneDecision);
      expect(parsed.type).toBe("done");
      if (parsed.type === "done") {
        expect(parsed.success).toBe(true);
        expect(parsed.result).toBe("Task completed successfully");
      }
    });
  });

  describe("4. Malformed Decision Rejections", () => {
    it("should reject malformed or unknown decision types", () => {
      expect(safeValidateVisionDecision({ type: "unknown_type" }).success).toBe(false);
      expect(safeValidateVisionDecision(null).success).toBe(false);
      expect(safeValidateVisionDecision("string").success).toBe(false);
      expect(safeValidateVisionDecision({}).success).toBe(false);
    });

    it("should reject computer action with out-of-bounds coordinates", () => {
      const invalidClick = {
        type: "computer_action",
        action: {
          type: "click",
          x: 1200, // exceeds 1000
          y: 400,
        },
      };
      const res = safeValidateVisionDecision(invalidClick);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toContain("action.x");
      }
    });

    it("should reject drag path with fewer than 2 points", () => {
      const invalidDrag = {
        type: "computer_action",
        action: {
          type: "drag",
          path: [{ x: 100, y: 100 }],
        },
      };
      expect(safeValidateVisionDecision(invalidDrag).success).toBe(false);
    });

    it("should reject invalid browser navigation URL", () => {
      const invalidNav = {
        type: "browser_action",
        action: {
          type: "navigate",
          url: "not-a-valid-url",
        },
      };
      expect(safeValidateVisionDecision(invalidNav).success).toBe(false);
    });

    it("should reject invalid certainty level", () => {
      const invalidCertainty = {
        type: "done",
        certainty: "super_confident", // invalid enum
      };
      expect(safeValidateVisionDecision(invalidCertainty).success).toBe(false);
    });

    it("should throw in validateVisionDecision on invalid input", () => {
      expect(() => validateVisionDecision({ type: "invalid" })).toThrow(/Invalid VisionDecision payload/);
    });
  });
});
