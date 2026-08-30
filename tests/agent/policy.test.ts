import { describe, it, expect } from "vitest";
import { ActionPolicy, ActionPolicyContext } from "../../src/agent/policy.js";
import { NormalizedComputerAction } from "../../src/vision/types.js";

describe("ActionPolicy Safety & Precision Enforcement", () => {
  const baseContext: ActionPolicyContext = {
    objective: "Fill application form",
    certainty: "certain",
    currentUrl: "https://app.test/form",
    stepIndex: 1,
    frameKind: "overview",
    recentActionsCount: 0,
  };

  describe("1. Default Certainty Rules", () => {
    const policy = new ActionPolicy();

    it("should allow any valid action when certainty is 'certain'", async () => {
      const clickAction: NormalizedComputerAction = { type: "click", x: 500, y: 500, button: "left" };
      const evalResult = await policy.evaluate(clickAction, {
        ...baseContext,
        certainty: "certain",
      });
      expect(evalResult).toBe("allow");
    });

    it("should allow ordinary actions (e.g. click) when certainty is 'likely'", async () => {
      const clickAction: NormalizedComputerAction = { type: "click", x: 500, y: 500, button: "left" };
      const evalResult = await policy.evaluate(clickAction, {
        ...baseContext,
        certainty: "likely",
      });
      expect(evalResult).toBe("allow");
    });

    it("should require inspection for precision-sensitive actions (e.g. drag) on overview when 'likely'", async () => {
      const dragAction: NormalizedComputerAction = {
        type: "drag",
        path: [
          { x: 100, y: 100 },
          { x: 500, y: 100 },
        ],
      };
      const evalResult = await policy.evaluate(dragAction, {
        ...baseContext,
        certainty: "likely",
        frameKind: "overview",
      });
      expect(evalResult).toBe("inspect");

      // Once on region frame, likely drag is allowed
      const regionResult = await policy.evaluate(dragAction, {
        ...baseContext,
        certainty: "likely",
        frameKind: "region",
      });
      expect(regionResult).toBe("allow");
    });

    it("should require inspection for any action when certainty is 'uncertain'", async () => {
      const clickAction: NormalizedComputerAction = { type: "click", x: 300, y: 400, button: "left" };
      const evalResult = await policy.evaluate(clickAction, {
        ...baseContext,
        certainty: "uncertain",
      });
      expect(evalResult).toBe("inspect");
    });
  });

  describe("2. Custom Policy Overrides", () => {
    it("should allow application to deny actions or require confirmation", async () => {
      const customPolicy = new ActionPolicy({
        beforeAction: (action, ctx) => {
          // Deny delete button clicks or navigation to external domains
          if (action.type === "navigate" && action.url.includes("danger.test")) {
            return "deny";
          }
          if (ctx.objective.includes("purchase") && action.type === "click") {
            return "require_confirmation";
          }
          return "allow";
        },
      });

      // 1. Navigation to dangerous domain denied
      const navResult = await customPolicy.evaluate(
        { type: "navigate", url: "https://danger.test/delete" },
        baseContext
      );
      expect(navResult).toBe("deny");

      // 2. Click in purchase flow requires confirmation
      const clickResult = await customPolicy.evaluate(
        { type: "click", x: 800, y: 600, button: "left" },
        { ...baseContext, objective: "complete checkout purchase" }
      );
      expect(clickResult).toBe("require_confirmation");

      // 3. Normal actions pass through to default certainty checks
      const normalResult = await customPolicy.evaluate(
        { type: "click", x: 100, y: 100, button: "left" },
        baseContext
      );
      expect(normalResult).toBe("allow");
    });
  });
});
