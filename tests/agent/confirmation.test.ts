import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChromeController } from "../../src/controller.js";
import { VisionAgent, VisionAgentRunResult } from "../../src/agent/runtime.js";
import { ActionPolicy } from "../../src/agent/policy.js";
import { VisionModelAdapter, validateVisionDecision } from "../../src/vision/adapter.js";
import { VisionCapabilities, VisionRequest, VisionDecision } from "../../src/vision/types.js";
import { launchRealChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";

class ConfirmationTestModel implements VisionModelAdapter {
  readonly id = "confirmation-test";
  readonly capabilities: VisionCapabilities = {};
  public receivedRequests: VisionRequest[] = [];

  private script: VisionDecision[];
  private callIndex = 0;

  constructor(script: VisionDecision[]) {
    this.script = script;
  }

  async decide(input: VisionRequest): Promise<VisionDecision> {
    this.receivedRequests.push(input);
    if (this.callIndex >= this.script.length) {
      return { type: "done", success: true, result: "Script exhausted" };
    }
    return this.script[this.callIndex++];
  }
}

describe("require_confirmation Policy Semantics", () => {
  let controller: ChromeController;
  let chrome: any;
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(0);
    chrome = await launchRealChrome({ windowSize: "1280,800" });
    controller = new ChromeController({
      mode: "ws-endpoint",
      wsEndpoint: chrome.wsUrl,
    });
    await controller.connect();
    await controller.navigationController.navigate(`${server.url}/interactive.html`);
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    if (controller) await controller.disconnect();
    if (chrome) await chrome.close();
    if (server) await server.close();
  });

  it("should NOT execute action when policy returns require_confirmation", async () => {
    // Model will request a click action
    const model = new ConfirmationTestModel([
      {
        type: "computer_action",
        action: { type: "click", x: 68, y: 151, button: "left" as const },
        certainty: "certain" as const,
        reasoning: "Click the button",
      },
    ]);

    // Policy hook returns require_confirmation for any click
    const policy = new ActionPolicy({
      beforeAction: (action) => {
        if (action.type === "click") return "require_confirmation";
        return "allow";
      },
    });

    // Spy on controller methods to prove they were never called
    let computerActionCallCount = 0;
    let browserActionCallCount = 0;
    const origComputer = controller.executeComputerAction.bind(controller);
    const origBrowser = controller.executeBrowserAction.bind(controller);
    controller.executeComputerAction = async (...args: any[]) => {
      computerActionCallCount++;
      return origComputer(...args);
    };
    controller.executeBrowserAction = async (...args: any[]) => {
      browserActionCallCount++;
      return origBrowser(...args);
    };

    try {
      const agent = new VisionAgent({ controller, model, policy });
      const result = await agent.run({
        objective: "Click the button",
        maxSteps: 5,
      });

      // 1. Action must NOT have been executed
      expect(computerActionCallCount).toBe(0);
      expect(browserActionCallCount).toBe(0);

      // 2. Result must indicate confirmation required
      expect(result.success).toBe(false);
      expect(result.error).toBe("CONFIRMATION_REQUIRED");

      // 3. Pending confirmation must contain the action details
      expect(result.pendingConfirmation).toBeDefined();
      expect(result.pendingConfirmation!.action.type).toBe("click");
      expect(result.pendingConfirmation!.decision.type).toBe("computer_action");
      expect(result.pendingConfirmation!.policyContext.objective).toBe("Click the button");
      expect(result.pendingConfirmation!.stepIndex).toBeGreaterThanOrEqual(0);
      expect(result.pendingConfirmation!.metrics).toBeDefined();
    } finally {
      // Restore original methods
      controller.executeComputerAction = origComputer;
      controller.executeBrowserAction = origBrowser;
    }
  });

  it("should verify the button was NOT clicked on the page", async () => {
    // First get baseline click count
    const stateBefore = await controller.session.send("Runtime.evaluate", {
      expression: "JSON.stringify(window.__STATE__ || { clicks: 0 })",
      returnByValue: true,
    });
    const clicksBefore = JSON.parse(stateBefore.result.value).clicks || 0;

    const model = new ConfirmationTestModel([
      {
        type: "computer_action",
        action: { type: "click", x: 68, y: 151, button: "left" as const },
        certainty: "certain" as const,
        reasoning: "Click the button",
      },
    ]);

    const policy = new ActionPolicy({
      beforeAction: () => "require_confirmation",
    });

    const agent = new VisionAgent({ controller, model, policy });
    await agent.run({ objective: "Click button", maxSteps: 5 });

    // Verify click count is unchanged — zero browser side effects
    const stateAfter = await controller.session.send("Runtime.evaluate", {
      expression: "JSON.stringify(window.__STATE__ || { clicks: 0 })",
      returnByValue: true,
    });
    const clicksAfter = JSON.parse(stateAfter.result.value).clicks || 0;
    expect(clicksAfter).toBe(clicksBefore);
  });

  it("should still allow actions when policy returns allow", async () => {
    const model = new ConfirmationTestModel([
      {
        type: "computer_action",
        action: { type: "click", x: 68, y: 151, button: "left" as const },
        certainty: "certain" as const,
        reasoning: "Click the button",
      },
      {
        type: "done",
        success: true,
        result: "Clicked successfully",
      },
    ]);

    const policy = new ActionPolicy({
      beforeAction: () => "allow",
    });

    const agent = new VisionAgent({ controller, model, policy });
    const result = await agent.run({ objective: "Click button", maxSteps: 5 });

    expect(result.success).toBe(true);
    expect(result.pendingConfirmation).toBeUndefined();
  });
});
