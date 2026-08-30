import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { ChromeController } from "../../src/controller.js";

describe("Live Chrome Coordinate Calibration across DPR Matrix", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(0);
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  for (const dpr of [1, 2]) {
    it(`should calibrate coordinates on Real Chrome with DPR ${dpr} within <= 2 CSS px error`, async () => {
      const chrome = await launchRealChrome({
        windowSize: "1280,800",
        deviceScaleFactor: dpr,
      });

      const controller = new ChromeController({
        mode: "ws-endpoint",
        wsEndpoint: chrome.wsUrl,
      });

      try {
        await controller.connect();
        await controller.navigationController.navigate(`${server.url}/calibration.html`);
        await new Promise((r) => setTimeout(r, 150));

        const targetsToTest = [
          { x: 100, y: 100 },
          { x: 500, y: 300 },
          { x: 1000, y: 700 },
        ];

        for (const target of targetsToTest) {
          // 1. Capture observation for each step (computer-use loop)
          const obs = await controller.observe({ showCursor: true });
          expect(obs.observationId).toBeTruthy();
          expect(obs.imageWidth).toBeGreaterThan(0);
          expect(obs.imageHeight).toBeGreaterThan(0);
          expect(obs.viewportWidth).toBe(1280);
          expect(obs.cursorPosition).toBeDefined();

          // Model supplies target coordinates in image pixel space
          const modelX = target.x / obs.coordinateSpace.scaleX;
          const modelY = target.y / obs.coordinateSpace.scaleY;

          const clickRes = await controller.executeComputerAction({
            type: "click",
            observationId: obs.observationId,
            x: modelX,
            y: modelY,
            button: "left",
          });
          expect(clickRes.success).toBe(true);
          await new Promise((r) => setTimeout(r, 60));
        }

        // 2. Inspect registered pointer click logs from real Chrome page
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

          // Real Chrome accuracy assertion: <= 2 CSS pixels across DPR 1 and 2!
          expect(deltaX).toBeLessThanOrEqual(2);
          expect(deltaY).toBeLessThanOrEqual(2);
        }
      } finally {
        await controller.disconnect();
        await chrome.close();
      }
    }, 25000);
  }

  it("should reject out-of-bounds coordinates with OUT_OF_BOUNDS error", async () => {
    const chrome = await launchRealChrome({ windowSize: "1280,800" });
    const controller = new ChromeController({ mode: "ws-endpoint", wsEndpoint: chrome.wsUrl });
    await controller.connect();

    try {
      await controller.navigationController.navigate(`${server.url}/calibration.html`);
      const obs = await controller.observe();

      const res = await controller.executeComputerAction({
        type: "click",
        observationId: obs.observationId,
        x: -500,
        y: 99999,
      });

      expect(res.success).toBe(false);
      expect(res.errorCode).toBe("OUT_OF_BOUNDS");
    } finally {
      await controller.disconnect();
      await chrome.close();
    }
  });

  it("should reject actions with stale observationId when visualEpoch increments", async () => {
    const chrome = await launchRealChrome({ windowSize: "1280,800" });
    const controller = new ChromeController({ mode: "ws-endpoint", wsEndpoint: chrome.wsUrl });
    await controller.connect();

    try {
      await controller.navigationController.navigate(`${server.url}/calibration.html`);
      const obs1 = await controller.observe();

      // Perform a click action that increments visualEpoch
      await controller.executeComputerAction({
        type: "click",
        observationId: obs1.observationId,
        x: 100,
        y: 100,
      });

      // Attempting to reuse obs1 must be rejected as STALE_OBSERVATION
      const staleRes = await controller.executeComputerAction({
        type: "click",
        observationId: obs1.observationId,
        x: 200,
        y: 200,
      });

      expect(staleRes.success).toBe(false);
      expect(staleRes.errorCode).toBe("STALE_OBSERVATION");
    } finally {
      await controller.disconnect();
      await chrome.close();
    }
  });
});
