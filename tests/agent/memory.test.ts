import { describe, it, expect } from "vitest";
import { AgentMemory } from "../../src/agent/memory.js";

describe("AgentMemory Context Compression & Bounded History", () => {
  it("1. should maintain strictly bounded recent steps (default 6)", () => {
    const memory = new AgentMemory("Submit login form", { maxSteps: 6 });

    for (let i = 1; i <= 20; i++) {
      memory.recordStep({
        stepIndex: i,
        actionDescription: `Clicked button #${i}`,
        intent: `progress step ${i}`,
        success: true,
      });
    }

    const state = memory.getState();
    expect(state.recentSteps).toHaveLength(6);
    expect(memory.totalSteps).toBe(20);

    // Oldest in queue should be step 15, newest step 20
    expect(state.recentSteps[0].stepIndex).toBe(15);
    expect(state.recentSteps[5].stepIndex).toBe(20);
  });

  it("2. should generate constant-size markdown summary over long runs", () => {
    const memory = new AgentMemory("Complete multi-step checkout form", { maxSteps: 5 });

    // Initial summary
    memory.recordStep({
      stepIndex: 1,
      actionDescription: "Navigate to checkout",
      success: true,
      url: "https://shop.test/checkout",
    });
    const len1 = memory.formatSummary().length;

    // Simulate 50 subsequent steps
    for (let i = 2; i <= 50; i++) {
      memory.recordStep({
        stepIndex: i,
        actionDescription: `Type input field #${i}`,
        intent: "fill form field",
        success: true,
      });
    }

    const len50 = memory.formatSummary().length;
    // Length at 50 steps should be roughly the same order of magnitude as length at 5 steps
    expect(len50).toBeLessThan(len1 * 3);

    const summary = memory.formatSummary();
    expect(summary).toContain("OBJECTIVE:");
    expect(summary).toContain("STATE:");
    expect(summary).toContain("RECENT ACTIONS (last 5 of 50 steps):");
    expect(summary).toContain("50. Type input field #50 [Intent: fill form field] -> ✓");
  });

  it("3. should track and clear last failure properly", () => {
    const memory = new AgentMemory("Upload document");

    memory.recordStep({
      stepIndex: 1,
      actionDescription: "Click upload button",
      success: false,
      error: "STALE_OBSERVATION: page reloaded",
    });

    expect(memory.getState().lastFailure).toBe("STALE_OBSERVATION: page reloaded");
    expect(memory.formatSummary()).toContain("Last Failure/Notice: STALE_OBSERVATION: page reloaded");

    // Next step succeeds -> failure notice cleared
    memory.recordStep({
      stepIndex: 2,
      actionDescription: "Click upload button again",
      success: true,
    });

    expect(memory.getState().lastFailure).toBeUndefined();
    expect(memory.formatSummary()).not.toContain("Last Failure/Notice");
  });

  it("4. should store deduplicated facts with bounded eviction", () => {
    const memory = new AgentMemory("Search product", { maxFacts: 3 });

    memory.addFact("Coupon code is SAVE20");
    memory.addFact("Coupon code is SAVE20"); // duplicate ignored
    memory.addFact("Free shipping above $50");
    memory.addFact("User is logged in as Guest");

    expect(memory.getState().facts).toEqual([
      "Coupon code is SAVE20",
      "Free shipping above $50",
      "User is logged in as Guest",
    ]);

    // Adding 4th fact evicts the 1st
    memory.addFact("Store closes at 9 PM");
    expect(memory.getState().facts).toEqual([
      "Free shipping above $50",
      "User is logged in as Guest",
      "Store closes at 9 PM",
    ]);
  });
});
