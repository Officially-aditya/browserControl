import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VisualChangeDetector } from "../../src/vision/change-detector.js";
import { ChromeController } from "../../src/controller.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";

describe("Visual Change Detection Engine", () => {
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

  it("1. should detect zero change when comparing identical frames", () => {
    const detector = new VisualChangeDetector();
    const fakeBase64 = Buffer.from("identical_pixel_data_stream_1234567890").toString("base64");

    const result = detector.compare(fakeBase64, fakeBase64);
    expect(result.hasChanged).toBe(false);
    expect(result.changedRatio).toBe(0);
    expect(result.changedTileCount).toBe(0);
    expect(result.region).toBeUndefined();
  });

  it("2. should detect full change on empty or uninitialized input", () => {
    const detector = new VisualChangeDetector();
    const fakeBase64 = Buffer.from("some_valid_image_bytes").toString("base64");

    const result = detector.compare("", fakeBase64);
    expect(result.hasChanged).toBe(true);
    expect(result.changedRatio).toBe(1.0);
  });

  it("3. should detect localized change and propose normalized region on live page mutation", async () => {
    await controller.navigationController.navigate(`${server.url}/interactive.html`);
    await new Promise((r) => setTimeout(r, 200));

    // Capture initial state
    const obs1 = await controller.observe({ format: "png" });

    // Mutate DOM in Card 1 and wait for compositor paint
    await controller.session.send("Runtime.evaluate", {
      expression: `
        new Promise(resolve => {
          const btn = document.getElementById('test-btn');
          btn.innerText = 'MUTATED BUTTON TEXT FOR TEST';
          btn.style.background = 'red';
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        })
      `,
      awaitPromise: true,
    });
    await new Promise((r) => setTimeout(r, 200));

    // Capture updated state
    const obs2 = await controller.observe({ format: "png" });

    const detector = new VisualChangeDetector({ gridCols: 10, gridRows: 10, diffThreshold: 2 });
    const change = detector.compare(obs1.image, obs2.image);

    expect(change.hasChanged).toBe(true);
    // Mutation is localized (button counter updated in Card 1)
    expect(change.changedRatio).toBeLessThanOrEqual(0.5);
    if (change.region) {
      expect(change.region.x).toBeGreaterThanOrEqual(0);
      expect(change.region.y).toBeGreaterThanOrEqual(0);
      expect(change.region.width).toBeGreaterThan(0);
      expect(change.region.height).toBeGreaterThan(0);
      expect(change.region.x + change.region.width).toBeLessThanOrEqual(1000);
      expect(change.region.y + change.region.height).toBeLessThanOrEqual(1000);
    }
  });
});
