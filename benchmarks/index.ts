import { launchRealChrome } from "../tests/helpers/chrome-launcher.js";
import { startTestServer } from "../tests/fixtures/test-server.js";
import { ChromeController } from "../src/controller.js";
import { runBenchmarkSuite } from "./runner.js";

async function main() {
  console.log("================================================================================");
  console.log("             CHROME COMPUTER USE - VISION RUNTIME BENCHMARK HARNESS            ");
  console.log("================================================================================\n");

  const server = await startTestServer(0);
  const chrome = await launchRealChrome({ windowSize: "1280,800" });
  const controller = new ChromeController({
    mode: "ws-endpoint",
    wsEndpoint: chrome.wsUrl,
  });

  try {
    await controller.connect();
    console.log(`Connected to Chrome at ${chrome.wsUrl}`);
    console.log(`Running 10 benchmark tasks (Mode A: Full Native vs Mode B: Adaptive Overview)...\n`);

    const report = await runBenchmarkSuite(controller, server.url);

    console.log("--------------------------------------------------------------------------------");
    console.log("TASK-BY-TASK COMPARISON:");
    console.log("--------------------------------------------------------------------------------");
    console.log(
      "Task".padEnd(38) +
      "Native (KB)".padEnd(14) +
      "Adaptive (KB)".padEnd(16) +
      "Byte Sav.".padEnd(12) +
      "Pixel Sav."
    );
    console.log("-".repeat(80));

    for (const t of report.tasks) {
      const natKb = (t.native.imageBytes / 1024).toFixed(1);
      const adaptKb = (t.adaptive.imageBytes / 1024).toFixed(1);
      const byteSav = `${t.byteReductionPercent}%`;
      const pixSav = `${t.pixelReductionPercent}%`;

      console.log(
        t.taskName.padEnd(38) +
        natKb.padEnd(14) +
        adaptKb.padEnd(16) +
        byteSav.padEnd(12) +
        pixSav
      );
    }

    console.log("-".repeat(80));
    console.log("\n================================================================================");
    console.log("SUMMARY REPORT:");
    console.log("================================================================================");
    console.log(`Total Tasks Executed: ${report.summary.totalTasks}`);
    console.log(`All Tasks Succeeded: ${report.summary.allSucceeded ? "✓ YES" : "✗ NO"}`);
    console.log(
      `Total Image Bytes Sent: ${(report.summary.totalNativeBytes / 1024).toFixed(1)} KB (Native) vs ${(report.summary.totalAdaptiveBytes / 1024).toFixed(1)} KB (Adaptive)`
    );
    console.log(`Overall Image Byte Reduction: ${report.summary.overallByteReductionPercent}%`);
    console.log(
      `Total Pixels Sent: ${report.summary.totalNativePixels.toLocaleString()} px (Native) vs ${report.summary.totalAdaptivePixels.toLocaleString()} px (Adaptive)`
    );
    console.log(`Overall Pixel Volume Reduction: ${report.summary.overallPixelReductionPercent}%`);
    console.log("================================================================================\n");

    // Output Machine-Readable JSON
    console.log("MACHINE-READABLE JSON OUTPUT:");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await controller.disconnect();
    await chrome.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
