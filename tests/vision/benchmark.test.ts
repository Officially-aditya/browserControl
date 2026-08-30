import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";
import { runBenchmarkSuite } from "../../benchmarks/runner.js";

describe("Vision Runtime Benchmark Suite (10 Tasks)", () => {
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
  }, 25000);

  afterAll(async () => {
    if (controller) await controller.disconnect();
    if (chrome) await chrome.close();
    if (server) await server.close();
  });

  it("should run all 10 benchmark tasks and prove quantitative reduction in bytes/pixels", async () => {
    const report = await runBenchmarkSuite(controller, server.url);

    expect(report.summary.totalTasks).toBe(10);
    expect(report.summary.allSucceeded).toBe(true);

    // Assert that adaptive mode reduces total bytes sent by at least 40%
    expect(report.summary.overallByteReductionPercent).toBeGreaterThan(40);
    expect(report.summary.totalAdaptiveBytes).toBeLessThan(report.summary.totalNativeBytes);
    expect(report.summary.overallPixelReductionPercent).toBeGreaterThan(0);
    expect(report.summary.totalAdaptivePixels).toBeLessThan(report.summary.totalNativePixels);

    // Verify all 10 tasks are present and succeeded in both modes
    for (const t of report.tasks) {
      expect(t.native.success).toBe(true);
      expect(t.adaptive.success).toBe(true);
      expect(t.byteReductionPercent).toBeGreaterThan(30);
    }
  }, 40000);
});
