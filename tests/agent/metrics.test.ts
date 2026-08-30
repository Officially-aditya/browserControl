import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";
import { VisionAgent } from "../../src/agent/runtime.js";
import { MetricsCollector } from "../../src/agent/metrics.js";
import { VisionModelAdapter } from "../../src/vision/adapter.js";
import { VisionRequest, VisionDecision, VisionCapabilities } from "../../src/vision/types.js";

describe("AgentMetrics and Performance Tracking", () => {
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

  it("1. should accumulate metrics accurately in unit isolation", () => {
    const collector = new MetricsCollector();

    // 1. Overview frame capture
    collector.recordFrameCaptured("overview");
    collector.recordModelCall(
      [
        {
          image: "dGVzdC1pbWFnZQ==", // 10 bytes base64 payload
          mimeType: "image/webp",
          width: 1280,
          height: 800,
          kind: "overview",
          sourceRegion: { x: 0, y: 0, width: 1280, height: 800 },
        },
      ],
      120
    );

    // 2. Region frame capture
    collector.recordFrameCaptured("region");
    collector.recordModelCall(
      [
        {
          image: "cmVnaW9u", // 6 bytes
          mimeType: "image/png",
          width: 300,
          height: 200,
          kind: "region",
          sourceRegion: { x: 100, y: 100, width: 300, height: 200 },
        },
      ],
      80
    );

    // 3. Actions
    collector.recordAction(true, 45);
    collector.recordAction(false, 30, "STALE_OBSERVATION");

    const m = collector.getMetrics();
    expect(m.modelCalls).toBe(2);
    expect(m.overviewFrames).toBe(1);
    expect(m.regionFrames).toBe(1);
    expect(m.inspections).toBe(1);
    expect(m.imagePixelsSent).toBe(1280 * 800 + 300 * 200);
    expect(m.imageBytesSent).toBe(10 + 6);
    expect(m.actionsExecuted).toBe(2);
    expect(m.failedActions).toBe(1);
    expect(m.staleRetries).toBe(1);
    expect(m.modelLatencyMs).toBe(200);
    expect(m.browserLatencyMs).toBe(75);
    expect(m.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("2. should return deterministic metrics in live fake-model execution", async () => {
    let callIdx = 0;
    const fakeModel: VisionModelAdapter = {
      id: "deterministic-metric-model",
      capabilities: { maxImages: 1, supportsStructuredOutput: true, preferredFormat: "webp" },
      decide: async () => {
        callIdx++;
        if (callIdx === 1) {
          // Inspect region
          return {
            type: "inspect_region",
            region: { x: 100, y: 100, width: 200, height: 200 },
            certainty: "uncertain",
          };
        }
        if (callIdx === 2) {
          // Click button
          return {
            type: "computer_action",
            action: { type: "click", x: 500, y: 500, button: "left" },
            certainty: "certain",
          };
        }
        return {
          type: "done",
          success: true,
          result: "Done",
        };
      },
    };

    const agent = new VisionAgent({
      controller,
      model: fakeModel,
    });

    const result = await agent.run({
      objective: "Metric run",
      initialUrl: `${server.url}/interactive.html`,
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(result.metrics).toBeDefined();

    const m = result.metrics;
    expect(m.modelCalls).toBe(3);
    expect(m.overviewFrames).toBe(2); // Initial overview + overview after action
    expect(m.regionFrames).toBe(1); // One region inspection
    expect(m.inspections).toBe(1);
    expect(m.actionsExecuted).toBe(2); // 1 initial navigation + 1 click
    expect(m.failedActions).toBe(0);
    expect(m.staleRetries).toBe(0);
    expect(m.imagePixelsSent).toBeGreaterThan(0);
    expect(m.imageBytesSent).toBeGreaterThan(0);
    expect(m.totalDurationMs).toBeGreaterThan(0);
  });
});
