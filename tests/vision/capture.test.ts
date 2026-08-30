import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";
import { VisionCaptureService } from "../../src/vision/capture.js";
import { VisionFrameMapper } from "../../src/vision/frame-mapper.js";

describe("Adaptive Vision Capture Service", () => {
  let chrome: LaunchedChrome;
  let server: TestServer;
  let controller: ChromeController;
  let captureService: VisionCaptureService;

  beforeAll(async () => {
    server = await startTestServer(0);
    chrome = await launchRealChrome({ windowSize: "1280,800" });
    controller = new ChromeController({
      mode: "ws-endpoint",
      wsEndpoint: chrome.wsUrl,
    });
    await controller.connect();
    captureService = new VisionCaptureService(controller, {
      overviewFormat: "webp",
      overviewQuality: 80,
      regionFormat: "png",
    });

    // Navigate to calibration target page
    await controller.executeBrowserAction({
      type: "navigate",
      url: `${server.url}/calibration.html`,
    });
    await new Promise((r) => setTimeout(r, 200));
  }, 20000);

  afterAll(async () => {
    if (controller) await controller.disconnect();
    if (chrome) await chrome.close();
    if (server) await server.close();
  });

  it("should capture an optimized overview frame with valid metadata", async () => {
    const { observation, frame } = await captureService.captureOverview();

    expect(observation.observationId).toBeTruthy();
    expect(frame.kind).toBe("overview");
    expect(frame.sourceObservationId).toBe(observation.observationId);
    expect(frame.visualEpoch).toBe(observation.visualEpoch);
    expect(frame.width).toBe(observation.imageWidth);
    expect(frame.height).toBe(observation.imageHeight);
    expect(frame.sourceRegion.x).toBe(0);
    expect(frame.sourceRegion.y).toBe(0);
    expect(frame.sourceRegion.width).toBe(observation.imageWidth);
    expect(frame.sourceRegion.height).toBe(observation.imageHeight);
    expect(frame.image).toBeTruthy();
  });

  it("should capture a high-detail clipped region frame for normalized sub-region", async () => {
    const { frame: overviewFrame } = await captureService.captureOverview();

    // Request center region: x: 250..750 (width 500), y: 250..750 (height 500)
    const normalizedCrop = { x: 250, y: 250, width: 500, height: 500 };
    const regionFrame = await captureService.captureRegion(normalizedCrop, overviewFrame);

    expect(regionFrame.kind).toBe("region");
    expect(regionFrame.sourceObservationId).toBe(overviewFrame.sourceObservationId);
    expect(regionFrame.visualEpoch).toBe(overviewFrame.visualEpoch);

    // Region width & height should approximate 50% of the full screenshot
    expect(regionFrame.sourceRegion.width).toBeCloseTo(overviewFrame.width * 0.5, 0);
    expect(regionFrame.sourceRegion.height).toBeCloseTo(overviewFrame.height * 0.5, 0);
    expect(regionFrame.sourceRegion.x).toBeCloseTo(overviewFrame.width * 0.25, 0);
    expect(regionFrame.sourceRegion.y).toBeCloseTo(overviewFrame.height * 0.25, 0);

    // Frame image dimensions should match the cropped pixel size
    expect(regionFrame.width).toBeGreaterThan(0);
    expect(regionFrame.height).toBeGreaterThan(0);
  });

  it("should accurately execute actions mapped from region frame coordinates on live page", async () => {
    const { frame: overviewFrame } = await captureService.captureOverview();

    // Target a specific sub-region containing a button/target
    const crop = { x: 400, y: 300, width: 300, height: 300 };
    const regionFrame = await captureService.captureRegion(crop, overviewFrame);

    // Model decides to click at center of this region (500, 500 inside region frame)
    const mappedAction = VisionFrameMapper.mapNormalizedComputerAction(
      { type: "click", x: 500, y: 500, button: "left" },
      regionFrame
    );

    expect(mappedAction.observationId).toBe(overviewFrame.sourceObservationId);

    // Execute the action via ChromeController
    const res = await controller.executeComputerAction(mappedAction);
    expect(res.success).toBe(true);
  });

  it("should reject region capture on stale/unknown observation", async () => {
    const fakeFrame = {
      frameId: "fake",
      sourceObservationId: "obs_non_existent_9999",
      visualEpoch: 1,
      image: "",
      mimeType: "image/png",
      width: 1000,
      height: 800,
      sourceRegion: { x: 0, y: 0, width: 1000, height: 800 },
      kind: "overview" as const,
      timestamp: Date.now(),
    };

    await expect(
      captureService.captureRegion({ x: 100, y: 100, width: 200, height: 200 }, fakeFrame)
    ).rejects.toMatchObject({
      errorCode: "STALE_OBSERVATION",
    });
  });
});
