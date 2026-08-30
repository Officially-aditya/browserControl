import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";
import { VisionAgent } from "../../src/agent/runtime.js";
import { VisionModelAdapter } from "../../src/vision/adapter.js";
import { VisionRequest, VisionDecision, VisionCapabilities } from "../../src/vision/types.js";

class ScriptedFakeModel implements VisionModelAdapter {
  readonly id = "scripted-fake-model";
  readonly capabilities: VisionCapabilities = {
    maxImages: 1,
    supportsStructuredOutput: true,
    preferredFormat: "webp",
  };

  private script: VisionDecision[];
  public receivedRequests: VisionRequest[] = [];

  constructor(script: VisionDecision[]) {
    this.script = [...script];
  }

  public async decide(input: VisionRequest): Promise<VisionDecision> {
    this.receivedRequests.push(input);
    const next = this.script.shift();
    if (!next) {
      return { type: "done", success: true, result: "Script finished" };
    }
    return next;
  }
}

describe("VisionAgent Runtime With Deterministic Fake Model", () => {
  let chrome: LaunchedChrome;
  let server: TestServer;
  let controller: ChromeController;

  beforeAll(async () => {
    server = await startTestServer(0);
    chrome = await launchRealChrome({ windowSize: "1280,800" });
    controller = new ChromeController({
      mode: "ws-endpoint",
      wsEndpoint: chrome.wsUrl,
    });
    await controller.connect();
  }, 20000);

  afterAll(async () => {
    if (controller) await controller.disconnect();
    if (chrome) await chrome.close();
    if (server) await server.close();
  });

  it("1. should execute standard flow: overview -> click -> type -> done", async () => {
    const fakeModel = new ScriptedFakeModel([
      {
        type: "computer_action",
        action: { type: "click", x: 200, y: 150, button: "left" },
        certainty: "certain",
        intent: "focus text input",
      },
      {
        type: "computer_action",
        action: { type: "type", text: "Hello AI", method: "auto" },
        certainty: "certain",
        intent: "type greeting text",
      },
      {
        type: "done",
        success: true,
        result: "Text typed successfully",
      },
    ]);

    const agent = new VisionAgent({
      controller,
      model: fakeModel,
    });

    const result = await agent.run({
      objective: "Click input and type greeting",
      initialUrl: `${server.url}/interactive.html`,
      maxSteps: 10,
    });

    expect(result.success).toBe(true);
    expect(result.resultMessage).toBe("Text typed successfully");
    expect(result.totalSteps).toBe(3);
    expect(fakeModel.receivedRequests.length).toBe(3);

    // Verify frames in requests were valid
    expect(fakeModel.receivedRequests[0].frames[0].kind).toBe("overview");
    expect(fakeModel.receivedRequests[0].objective).toBe("Click input and type greeting");
  });

  it("2. should execute adaptive inspection flow: overview -> inspect_region -> region click -> done", async () => {
    const fakeModel = new ScriptedFakeModel([
      {
        type: "inspect_region",
        region: { x: 300, y: 200, width: 400, height: 300 },
        certainty: "uncertain",
        reasoning: "Zoom in on target control area",
      },
      {
        type: "computer_action",
        action: { type: "click", x: 500, y: 500, button: "left" },
        certainty: "certain",
        intent: "click centered button inside high-detail region",
      },
      {
        type: "done",
        success: true,
        result: "Button clicked via region inspection",
      },
    ]);

    const agent = new VisionAgent({
      controller,
      model: fakeModel,
    });

    const result = await agent.run({
      objective: "Inspect button area and click",
      initialUrl: `${server.url}/calibration.html`,
      maxSteps: 10,
    });

    expect(result.success).toBe(true);
    expect(result.totalSteps).toBe(3);

    // The second request to the model must be a high-detail region frame!
    expect(fakeModel.receivedRequests[0].frames[0].kind).toBe("overview");
    expect(fakeModel.receivedRequests[1].frames[0].kind).toBe("region");
    expect(fakeModel.receivedRequests[1].frames[0].sourceRegion).toBeDefined();
  });

  it("3. should handle policy denials gracefully", async () => {
    const urlBefore = controller.session.currentUrl;
    const fakeModel = new ScriptedFakeModel([
      {
        type: "browser_action",
        action: { type: "navigate", url: "https://blocked.test" },
        certainty: "certain",
      },
      {
        type: "done",
        success: true,
        result: "Handled denial",
      },
    ]);

    const agent = new VisionAgent({
      controller,
      model: fakeModel,
      policy: {
        beforeAction: (action) => {
          if (action.type === "navigate" && action.url.includes("blocked.test")) {
            return "deny";
          }
          return "allow";
        },
      },
    });

    const result = await agent.run({
      objective: "Try navigating to blocked site",
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(controller.session.currentUrl).toBe(urlBefore);
  });

  it("4. should stop when maximum steps limit is exceeded", async () => {
    // Model returns infinite clicks without ever calling done
    const infiniteModel: VisionModelAdapter = {
      id: "infinite-model",
      capabilities: { maxImages: 1, supportsStructuredOutput: true, preferredFormat: "webp" },
      decide: async () => ({
        type: "computer_action",
        action: { type: "click", x: 100, y: 100, button: "left" },
        certainty: "certain",
      }),
    };

    const agent = new VisionAgent({
      controller,
      model: infiniteModel,
    });

    const result = await agent.run({
      objective: "Loop test",
      initialUrl: `${server.url}/interactive.html`,
      maxSteps: 3,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Maximum steps (3) reached");
    expect(result.totalSteps).toBe(3);
  });

  it("5. should recover from stale observation on in-page navigation and complete task", async () => {
    let callCount = 0;
    const modelWithStaleRecovery: VisionModelAdapter = {
      id: "stale-recovery-model",
      capabilities: { maxImages: 1, supportsStructuredOutput: true, preferredFormat: "webp" },
      decide: async () => {
        callCount++;
        if (callCount === 1) {
          // Trigger a navigation that increments visual epoch / changes DOM
          return {
            type: "browser_action",
            action: { type: "navigate", url: `${server.url}/interactive.html` },
            certainty: "certain",
          };
        }
        if (callCount === 2) {
          return {
            type: "computer_action",
            action: { type: "click", x: 200, y: 150, button: "left" },
            certainty: "certain",
          };
        }
        return {
          type: "done",
          success: true,
          result: "Recovered and completed",
        };
      },
    };

    const agent = new VisionAgent({
      controller,
      model: modelWithStaleRecovery,
    });

    const result = await agent.run({
      objective: "Navigate and click",
      initialUrl: `${server.url}/calibration.html`,
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(result.resultMessage).toBe("Recovered and completed");
  });

  it("6. should recover and continue when controlled tab is closed externally", async () => {
    // Open two tabs so closure recovers to the second tab
    const tab2 = await controller.tabController.newTab(`${server.url}/interactive.html`, true);
    const initialTargetId = controller.currentTargetId;

    let stepNum = 0;
    const modelWithClosure: VisionModelAdapter = {
      id: "closure-model",
      capabilities: { maxImages: 1, supportsStructuredOutput: true, preferredFormat: "webp" },
      decide: async () => {
        stepNum++;
        if (stepNum === 1) {
          // Close the controlled tab via raw CDP
          await controller.connection.send("Target.closeTarget", { targetId: initialTargetId! });
          await new Promise((r) => setTimeout(r, 200));

          return {
            type: "computer_action",
            action: { type: "click", x: 200, y: 200, button: "left" },
            certainty: "certain",
          };
        }
        return {
          type: "done",
          success: true,
          result: "Completed after target recovery",
        };
      },
    };

    const agent = new VisionAgent({
      controller,
      model: modelWithClosure,
    });

    const result = await agent.run({
      objective: "Survive tab closure",
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(result.resultMessage).toBe("Completed after target recovery");
  });
});
