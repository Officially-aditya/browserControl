import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";
import { VisionCaptureService } from "../../src/vision/capture.js";
import { ObservationPlanner } from "../../src/vision/planner.js";
import { VisionAgent } from "../../src/agent/runtime.js";
import { VisionModelAdapter } from "../../src/vision/adapter.js";
import { VisionRequest, VisionDecision, VisionCapabilities } from "../../src/vision/types.js";

describe("Adaptive Overview -> Inspect -> Action Optimization", () => {
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

  // ===========================================================================
  // 1. Pixel and Byte Reduction: Native PNG vs Adaptive WebP Overview
  // ===========================================================================
  it("should demonstrate measurable byte reduction with adaptive overview vs native PNG", async () => {
    await controller.navigationController.navigate(`${server.url}/interactive.html`);
    await new Promise((r) => setTimeout(r, 200));

    // Native full uncompressed screenshot
    const nativeObservation = await controller.observe({ format: "png" });
    const nativeBytes = Buffer.from(nativeObservation.image, "base64").length;
    const nativePixels = nativeObservation.imageWidth * nativeObservation.imageHeight;

    // Adaptive overview capture service (WebP, quality 82)
    const captureService = new VisionCaptureService(controller, {
      overviewFormat: "webp",
      overviewQuality: 82,
    });
    const { frame: overviewFrame } = await captureService.captureOverview();
    const overviewBytes = Buffer.from(overviewFrame.image, "base64").length;
    const overviewPixels = overviewFrame.width * overviewFrame.height;

    // High detail region crop (e.g. 200x200 normalized box)
    const regionFrame = await captureService.captureRegion(
      { x: 50, y: 100, width: 150, height: 150 },
      overviewFrame
    );
    const regionBytes = Buffer.from(regionFrame.image, "base64").length;
    const regionPixels = regionFrame.width * regionFrame.height;

    // Assertions
    expect(overviewBytes).toBeLessThan(nativeBytes);
    expect(regionPixels).toBeLessThan(nativePixels * 0.1); // Region is under 10% of full viewport pixels
    expect(regionBytes).toBeLessThan(nativeBytes);

    console.log(
      `[Perception Efficiency] Native PNG: ${(nativeBytes / 1024).toFixed(1)} KB (${nativePixels} px) | ` +
      `Adaptive WebP Overview: ${(overviewBytes / 1024).toFixed(1)} KB (${overviewPixels} px) | ` +
      `High-Detail Region Crop: ${(regionBytes / 1024).toFixed(1)} KB (${regionPixels} px)`
    );
  });

  // ===========================================================================
  // 2. Desired Loop Behavior: Overview -> Certain -> Direct Action
  // ===========================================================================
  it("should execute direct action without region inspection when model is certain", async () => {
    const requests: VisionRequest[] = [];
    const certainModel: VisionModelAdapter = {
      id: "certain-model",
      capabilities: { maxImages: 1, supportsStructuredOutput: true, preferredFormat: "webp" },
      decide: async (req) => {
        requests.push(req);
        if (requests.length === 1) {
          return {
            type: "computer_action",
            action: { type: "click", x: 68, y: 151, button: "left" },
            certainty: "certain",
            intent: "confident click on target",
          };
        }
        return { type: "done", success: true, result: "Done in 1 action step" };
      },
    };

    const agent = new VisionAgent({
      controller,
      model: certainModel,
      vision: {
        overviewFormat: "webp",
        overviewQuality: 82,
      },
    });

    const result = await agent.run({
      objective: "Click target confidently",
      initialUrl: `${server.url}/interactive.html`,
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(requests.length).toBe(2);
    // Request 1 is overview, Request 2 is overview after action
    expect(requests[0].frames[0].kind).toBe("overview");
    expect(requests[1].frames[0].kind).toBe("overview");
  });

  // ===========================================================================
  // 3. Desired Loop Behavior: Overview -> Uncertain -> Region -> Certain Action
  // ===========================================================================
  it("should trigger high-detail inspection when uncertain, then execute action", async () => {
    const requests: VisionRequest[] = [];
    const adaptiveModel: VisionModelAdapter = {
      id: "adaptive-model",
      capabilities: { maxImages: 1, supportsStructuredOutput: true, preferredFormat: "webp" },
      decide: async (req) => {
        requests.push(req);
        if (requests.length === 1) {
          // Model uncertain on overview -> requests inspection
          return {
            type: "inspect_region",
            region: { x: 40, y: 80, width: 150, height: 150 },
            certainty: "uncertain",
            reasoning: "Need zoom to confirm button position",
          };
        }
        if (requests.length === 2) {
          // Model receives high-detail region frame and is now certain
          return {
            type: "computer_action",
            action: { type: "click", x: 400, y: 400, button: "left" },
            certainty: "certain",
            intent: "click verified target inside region",
          };
        }
        return { type: "done", success: true, result: "Completed after inspection" };
      },
    };

    const agent = new VisionAgent({
      controller,
      model: adaptiveModel,
      vision: {
        overviewFormat: "webp",
        overviewQuality: 82,
        regionFormat: "png",
        maxRegionInspectionsPerStep: 2,
      },
    });

    const result = await agent.run({
      objective: "Inspect then click",
      initialUrl: `${server.url}/interactive.html`,
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(requests.length).toBe(3);
    expect(requests[0].frames[0].kind).toBe("overview");
    expect(requests[1].frames[0].kind).toBe("region");
    expect(requests[2].frames[0].kind).toBe("overview");
  });

  // ===========================================================================
  // 4. Loop Prevention: maxRegionInspectionsPerStep Enforcement
  // ===========================================================================
  it("should prevent infinite inspection loops when model repeatedly requests region inspects", async () => {
    let inspectCount = 0;
    const loopingModel: VisionModelAdapter = {
      id: "looping-model",
      capabilities: { maxImages: 1, supportsStructuredOutput: true, preferredFormat: "webp" },
      decide: async () => {
        inspectCount++;
        // Continuous uncertain inspection requests
        return {
          type: "inspect_region",
          region: { x: 100, y: 100, width: 200, height: 200 },
          certainty: "uncertain",
          reasoning: `Inspect loop request #${inspectCount}`,
        };
      },
    };

    const planner = new ObservationPlanner({
      maxSteps: 10,
      maxRegionInspectionsPerStep: 2,
    });

    // Simulate frame capture & inspect requests
    planner.onFrameCaptured({
      frameId: "f1",
      sourceObservationId: "obs1",
      visualEpoch: 1,
      image: "",
      mimeType: "image/webp",
      width: 1280,
      height: 800,
      sourceRegion: { x: 0, y: 0, width: 1280, height: 800 },
      kind: "overview",
    });

    // 1st inspect -> Allowed
    const step1 = planner.onDecisionReceived({
      type: "inspect_region",
      region: { x: 100, y: 100, width: 200, height: 200 },
      certainty: "uncertain",
    });
    expect(step1.nextAction).toBe("capture_region");

    // Region captured
    planner.onFrameCaptured({
      frameId: "f2",
      sourceObservationId: "obs1",
      visualEpoch: 1,
      image: "",
      mimeType: "image/png",
      width: 256,
      height: 160,
      sourceRegion: { x: 128, y: 80, width: 256, height: 160 },
      kind: "region",
    });

    // 2nd inspect -> Allowed (limit 2)
    const step2 = planner.onDecisionReceived({
      type: "inspect_region",
      region: { x: 100, y: 100, width: 200, height: 200 },
      certainty: "uncertain",
    });
    expect(step2.nextAction).toBe("capture_region");

    // 3rd inspect -> Exceeds maxRegionInspectionsPerStep -> resets to fresh overview, preventing loop
    const step3 = planner.onDecisionReceived({
      type: "inspect_region",
      region: { x: 100, y: 100, width: 200, height: 200 },
      certainty: "uncertain",
    });
    expect(step3.nextAction).toBe("capture_overview");
  });
});
