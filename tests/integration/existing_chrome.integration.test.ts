import { describe, it, expect, vi } from "vitest";
import { ChromeController } from "../../src/controller.js";
import { launchRealChrome } from "../helpers/chrome-launcher.js";

const isOptedIn =
  process.env.TEST_EXISTING_CHROME === "1" ||
  process.env.TEST_EXISTING_CHROME === "true" ||
  Boolean(process.env.CHROME_WS_ENDPOINT) ||
  Boolean(process.env.CHROME_BROWSER_URL);

describe("Existing Chrome Opt-In Smoke Test", () => {
  it.skipIf(!isOptedIn)(
    "should connect to existing live Chrome, inspect doctor metrics, capture observation, and disconnect safely",
    async () => {
      const mode = process.env.CHROME_WS_ENDPOINT
        ? "ws-endpoint"
        : process.env.CHROME_BROWSER_URL
        ? "browser-url"
        : "auto";

      const controller = new ChromeController({
        mode: mode as any,
        browserUrl: process.env.CHROME_BROWSER_URL || (mode === "auto" ? undefined : "http://127.0.0.1:9222"),
        wsEndpoint: process.env.CHROME_WS_ENDPOINT,
      });

      try {
        // 1. Connect to user's existing Chrome
        await controller.connect();
        expect(controller.isConnected).toBe(true);
        expect(controller.currentTargetId).toBeTruthy();

        // 2. Doctor diagnostics check
        const diagnostic = await controller.doctor();
        expect(diagnostic.connected).toBe(true);
        expect(diagnostic.targetId).toBeTruthy();
        expect(diagnostic.visualEpoch).toBeGreaterThanOrEqual(1);

        // 3. Tab enumeration
        const tabs = await controller.getTabs();
        expect(Array.isArray(tabs)).toBe(true);
        expect(tabs.length).toBeGreaterThanOrEqual(1);

        // 4. Capture visual screenshot observation
        const obs = await controller.observe({ showCursor: true });
        expect(obs.observationId).toBeTruthy();
        expect(obs.imageWidth).toBeGreaterThan(0);
        expect(obs.imageHeight).toBeGreaterThan(0);
        expect(obs.coordinateSpace.scaleX).toBeGreaterThan(0);
        expect(obs.coordinateSpace.scaleY).toBeGreaterThan(0);

        // 5. Perform safe non-destructive visual cursor movement
        const moveRes = await controller.executeComputerAction({
          type: "move",
          observationId: obs.observationId,
          x: Math.min(200, obs.imageWidth / 2),
          y: Math.min(200, obs.imageHeight / 2),
        });
        expect(moveRes.success).toBe(true);
      } finally {
        // 6. Cleanly disconnect without terminating the user's Chrome instance
        await controller.disconnect();
      }
    },
    20000
  );

  it("should verify existing-Chrome connection flow and non-destructive smoke actions against launched instance", async () => {
    // Spin up an isolated Chrome instance simulating an existing background Chrome process
    const simulatedChrome = await launchRealChrome({ windowSize: "1280,800" });
    const controller = new ChromeController({
      mode: "ws-endpoint",
      wsEndpoint: simulatedChrome.wsUrl,
    });

    try {
      await controller.connect();
      expect(controller.isConnected).toBe(true);
      expect(controller.currentTargetId).toBeTruthy();

      const doc = await controller.doctor();
      expect(doc.connected).toBe(true);
      expect(doc.targetId).toBeTruthy();

      const tabs = await controller.getTabs();
      expect(tabs.length).toBeGreaterThanOrEqual(1);

      const obs = await controller.observe({ showCursor: true });
      expect(obs.observationId).toBeTruthy();

      const moveRes = await controller.executeComputerAction({
        type: "move",
        observationId: obs.observationId,
        x: 100,
        y: 100,
      });
      expect(moveRes.success).toBe(true);

      // Disconnect cleanly
      await controller.disconnect();
      expect(controller.isConnected).toBe(false);
    } finally {
      await simulatedChrome.close();
    }
  }, 20000);

  it.runIf(!isOptedIn)("opt-in instructions when existing-Chrome smoke test is skipped", () => {
    console.info(
      "\n[Opt-In Smoke Test Skipped]\n" +
        "To run this smoke test against an existing Chrome instance:\n" +
        "  1. Start Chrome with remote debugging: chrome --remote-debugging-port=9222\n" +
        "  2. Run: npm run test:smoke (or TEST_EXISTING_CHROME=1 npm test)\n"
    );
    expect(true).toBe(true);
  });
});

