import { ChromeController } from "../src/controller.js";
import { benchmarkTasks, BenchmarkTaskContext } from "./tasks.js";
import { BenchmarkSuiteReport, BenchmarkComparison } from "./types.js";

export async function runBenchmarkSuite(
  controller: ChromeController,
  serverUrl: string
): Promise<BenchmarkSuiteReport> {
  const ctx: BenchmarkTaskContext = { controller, serverUrl };
  const comparisons: BenchmarkComparison[] = [];

  let totalNativeBytes = 0;
  let totalAdaptiveBytes = 0;
  let totalNativePixels = 0;
  let totalAdaptivePixels = 0;
  let totalNativeDuration = 0;
  let totalAdaptiveDuration = 0;
  let allSucceeded = true;

  for (const task of benchmarkTasks) {
    // Mode A: Full Native Mode
    const nativeRes = await task.run("full_native", ctx);
    if (!nativeRes.success) allSucceeded = false;

    // Mode B: Adaptive Overview Mode
    const adaptiveRes = await task.run("adaptive_overview", ctx);
    if (!adaptiveRes.success) allSucceeded = false;

    const byteReductionPercent =
      nativeRes.imageBytes > 0
        ? Number((((nativeRes.imageBytes - adaptiveRes.imageBytes) / nativeRes.imageBytes) * 100).toFixed(2))
        : 0;

    const pixelReductionPercent =
      nativeRes.imagePixels > 0
        ? Number((((nativeRes.imagePixels - adaptiveRes.imagePixels) / nativeRes.imagePixels) * 100).toFixed(2))
        : 0;

    totalNativeBytes += nativeRes.imageBytes;
    totalAdaptiveBytes += adaptiveRes.imageBytes;
    totalNativePixels += nativeRes.imagePixels;
    totalAdaptivePixels += adaptiveRes.imagePixels;
    totalNativeDuration += nativeRes.taskDurationMs;
    totalAdaptiveDuration += adaptiveRes.taskDurationMs;

    comparisons.push({
      taskId: task.id,
      taskName: task.name,
      native: nativeRes,
      adaptive: adaptiveRes,
      byteReductionPercent,
      pixelReductionPercent,
      durationDifferenceMs: adaptiveRes.taskDurationMs - nativeRes.taskDurationMs,
    });
  }

  const overallByteReductionPercent =
    totalNativeBytes > 0
      ? Number((((totalNativeBytes - totalAdaptiveBytes) / totalNativeBytes) * 100).toFixed(2))
      : 0;

  const overallPixelReductionPercent =
    totalNativePixels > 0
      ? Number((((totalNativePixels - totalAdaptivePixels) / totalNativePixels) * 100).toFixed(2))
      : 0;

  return {
    timestamp: new Date().toISOString(),
    tasks: comparisons,
    summary: {
      totalTasks: benchmarkTasks.length,
      allSucceeded,
      totalNativeBytes,
      totalAdaptiveBytes,
      overallByteReductionPercent,
      totalNativePixels,
      totalAdaptivePixels,
      overallPixelReductionPercent,
      totalNativeDurationMs: totalNativeDuration,
      totalAdaptiveDurationMs: totalAdaptiveDuration,
    },
  };
}
