import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { ChromeController } from "../../src/controller.js";

describe("Live Chrome Coordinate Calibration & Real Pixel Precision", () => {
  let server: TestServer;
  let chrome: LaunchedChrome;
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

  it("should capture real screenshot and verify exact CSS-pixel coordinate mapping", async () => {
    await controller.navigationController.navigate(`${server.url}/calibration.html`);

    // 1. Capture real observation
    const obs = await controller.observe();
    expect(obs.observationId).toBeTruthy();
    expect(obs.imageWidth).toBeGreaterThan(0);
    expect(obs.imageHeight).toBeGreaterThan(0);
    expect(obs.viewportWidth).toBeGreaterThan(0);
    expect(obs.viewportHeight).toBeGreaterThan(0);

    // 2. Click known targets on real calibration page
    const targetsToTest = [
      { x: 100, y: 100 },
      { x: 500, y: 300 },
      { x: 1000, y: 700 },
    ];

    for (const target of targetsToTest) {
      const clickRes = await controller.executeComputerAction({
        type: "click",
        observationId: obs.observationId,
        x: target.x,
        y: target.y,
        button: "left",
      });
      expect(clickRes.success).toBe(true);
      await new Promise((r) => setTimeout(r, 60));
    }

    // 3. Inspect registered pointer click logs from real Chrome page
    const evalRes = await controller.session.send<{ result: { value: any[] } }>("Runtime.evaluate", {
      expression: "window.__CLICK_LOGS__",
      returnByValue: true,
    });

    const clickLogs = evalRes.result.value;
    expect(clickLogs.length).toBe(targetsToTest.length);

    for (let i = 0; i < targetsToTest.length; i++) {
      const expected = targetsToTest[i];
      const actual = clickLogs[i];

      const deltaX = Math.abs(actual.clientX - expected.x);
      const deltaY = Math.abs(actual.clientY - expected.y);

      // Real Chrome accuracy assertion: <= 2 CSS pixels!
      expect(deltaX).toBeLessThanOrEqual(2);
      expect(deltaY).toBeLessThanOrEqual(2);
    }
  });

  it("should reject out-of-bounds coordinates with OUT_OF_BOUNDS error", async () => {
    const res = await controller.executeComputerAction({
      type: "click",
      x: -500,
      y: 99999,
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("OUT_OF_BOUNDS");
  });

  it("should reject actions with stale observationId when page navigates", async () => {
    const obs = await controller.observe();

    // Navigate away to make observation stale
    await controller.navigationController.navigate(`${server.url}/interactive.html`);

    const staleRes = await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: 200,
      y: 200,
    });

    expect(staleRes.success).toBe(false);
    expect(staleRes.errorCode).toBe("STALE_OBSERVATION");
  });
});
