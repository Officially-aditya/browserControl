import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { ChromeController } from "../../src/controller.js";

describe("Live Chrome Coordinate Calibration & Real Pixel Precision", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(0);
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  for (const dpr of [1, 2]) {
    it(`should verify accuracy (<= 2 CSS px) at corners, center & arbitrary points on Real Chrome (DPR ${dpr})`, async () => {
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

        // 1. Viewport & Screenshot dimension verification
        const obs = await controller.observe({ showCursor: true });
        expect(obs.observationId).toBeTruthy();
        expect(obs.viewportWidth).toBe(1280);
        expect(obs.viewportHeight).toBeGreaterThan(600);

        if (dpr === 1) {
          expect(obs.imageWidth).toBe(obs.viewportWidth);
          expect(obs.coordinateSpace.scaleX).toBeCloseTo(1, 2);
        } else if (dpr === 2) {
          expect(obs.imageWidth).toBe(obs.viewportWidth * 2);
          expect(obs.coordinateSpace.scaleX).toBeCloseTo(0.5, 2);
        }

        // 2. Image -> Viewport and Viewport -> Image conversion roundtrip
        const mapper = controller.screenshotService.currentMapper!;
        const testImgPt = { x: 300, y: 200 };
        const mappedVp = mapper.toViewport(testImgPt.x, testImgPt.y);
        const roundtripImg = mapper.toImage(mappedVp.x, mappedVp.y);
        expect(Math.abs(roundtripImg.x - testImgPt.x)).toBeLessThanOrEqual(0.05);
        expect(Math.abs(roundtripImg.y - testImgPt.y)).toBeLessThanOrEqual(0.05);

        // 3. Targets: Corners, Center, and Arbitrary coordinates (in CSS pixels)
        const targetsToTest = [
          { name: "Top-Left Corner", x: 15, y: 15 },
          { name: "Top-Right Corner", x: 1250, y: 15 },
          { name: "Center", x: 640, y: 380 },
          { name: "Bottom-Left Corner", x: 15, y: 700 },
          { name: "Bottom-Right Corner", x: 1250, y: 700 },
          { name: "Arbitrary Point 1", x: 235, y: 184 },
          { name: "Arbitrary Point 2", x: 890, y: 512 },
          { name: "Arbitrary Point 3", x: 1045, y: 640 },
        ];

        for (const target of targetsToTest) {
          // Fresh observation per step
          const stepObs = await controller.observe();

          // Calculate model coordinates in screenshot image pixel space
          const modelX = target.x / stepObs.coordinateSpace.scaleX;
          const modelY = target.y / stepObs.coordinateSpace.scaleY;

          const clickRes = await controller.executeComputerAction({
            type: "click",
            observationId: stepObs.observationId,
            x: modelX,
            y: modelY,
            button: "left",
          });
          expect(clickRes.success).toBe(true);
          await new Promise((r) => setTimeout(r, 40));
        }

        // 4. Runtime assertion verifying registered click locations on real Chrome
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
      } finally {
        await controller.disconnect();
        await chrome.close();
      }
    }, 30000);
  }

  it("should calibrate coordinates accurately under page scale zoom", async () => {
    const chrome = await launchRealChrome({ windowSize: "1280,800" });
    const controller = new ChromeController({ mode: "ws-endpoint", wsEndpoint: chrome.wsUrl });
    await controller.connect();

    try {
      await controller.navigationController.navigate(`${server.url}/calibration.html`);
      await new Promise((r) => setTimeout(r, 150));

      // Apply page scale factor
      try {
        await controller.session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.5 });
      } catch {}

      const obs = await controller.observe();
      expect(obs.observationId).toBeTruthy();

      const target = { x: 400, y: 300 };
      const modelX = target.x / obs.coordinateSpace.scaleX;
      const modelY = target.y / obs.coordinateSpace.scaleY;

      const clickRes = await controller.executeComputerAction({
        type: "click",
        observationId: obs.observationId,
        x: modelX,
        y: modelY,
      });
      expect(clickRes.success).toBe(true);

      const evalRes = await controller.session.send<{ result: { value: any[] } }>("Runtime.evaluate", {
        expression: "window.__CLICK_LOGS__",
        returnByValue: true,
      });

      const clickLogs = evalRes.result.value;
      const lastClick = clickLogs[clickLogs.length - 1];
      const deltaX = Math.abs(lastClick.clientX - target.x);
      const deltaY = Math.abs(lastClick.clientY - target.y);

      expect(deltaX).toBeLessThanOrEqual(2);
      expect(deltaY).toBeLessThanOrEqual(2);
    } finally {
      await controller.disconnect();
      await chrome.close();
    }
  });

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
