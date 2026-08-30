import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CallbackVisionAdapter } from "../../src/vision/callback-adapter.js";
import { VisionAgent } from "../../src/agent/runtime.js";
import { ChromeController } from "../../src/controller.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";

describe("CallbackVisionAdapter Universal Integration", () => {
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

  it("1. should execute callback function and validate normalized decisions", async () => {
    let receivedObjective = "";

    const adapter = new CallbackVisionAdapter({
      id: "mock-custom-model",
      capabilities: {
        preferredFormat: "jpeg",
        preferredLongEdge: 1200,
      },
      decide: async (req) => {
        receivedObjective = req.objective;
        return {
          type: "computer_action",
          action: { type: "click", x: 500, y: 500, button: "left" },
          certainty: "certain",
          intent: "click center",
        };
      },
    });

    expect(adapter.id).toBe("mock-custom-model");
    expect(adapter.capabilities.preferredFormat).toBe("jpeg");
    expect(adapter.capabilities.preferredLongEdge).toBe(1200);

    const decision = await adapter.decide({
      objective: "Click the center button",
      frames: [
        {
          image: "aW1hZ2U=",
          mimeType: "image/jpeg",
          width: 1280,
          height: 800,
          kind: "overview",
          sourceRegion: { x: 0, y: 0, width: 1280, height: 800 },
        },
      ],
      stepIndex: 1,
      maxSteps: 5,
    });

    expect(receivedObjective).toBe("Click the center button");
    expect(decision.type).toBe("computer_action");
  });

  it("2. should reject invalid callback outputs that violate the schema", async () => {
    const invalidAdapter = new CallbackVisionAdapter({
      decide: async () => {
        // Missing action payload / out-of-bound coords
        return {
          type: "computer_action",
          action: { type: "click", x: 1500, y: 500 }, // x > 1000 invalid!
        };
      },
    });

    await expect(
      invalidAdapter.decide({
        objective: "Test invalid",
        frames: [],
        stepIndex: 1,
        maxSteps: 5,
      })
    ).rejects.toThrow();
  });

  it("3. should run seamlessly with VisionAgent against live Chrome", async () => {
    let stepCount = 0;
    const adapter = new CallbackVisionAdapter({
      id: "live-callback-model",
      decide: async (req) => {
        stepCount++;
        expect(req.frames.length).toBeGreaterThan(0);
        expect(req.frames[0].image).toBeTruthy();

        if (stepCount === 1) {
          return {
            type: "computer_action",
            action: { type: "click", x: 68, y: 151, button: "left" },
            certainty: "certain",
            intent: "click button",
          };
        }
        return {
          type: "done",
          success: true,
          result: "Callback workflow finished",
        };
      },
    });

    const agent = new VisionAgent({
      controller,
      model: adapter,
    });

    const result = await agent.run({
      objective: "Click button via CallbackVisionAdapter",
      initialUrl: `${server.url}/interactive.html`,
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(result.resultMessage).toBe("Callback workflow finished");
    expect(result.metrics.modelCalls).toBe(2);
    expect(result.metrics.actionsExecuted).toBe(2); // 1 nav + 1 click
  });
});
