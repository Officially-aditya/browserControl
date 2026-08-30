import { AgentMetrics } from "../src/agent/metrics.js";

export type BenchmarkMode = "full_native" | "adaptive_overview";

export interface BenchmarkTaskResult {
  taskId: string;
  taskName: string;
  mode: BenchmarkMode;
  success: boolean;
  steps: number;
  modelCalls: number;
  overviewFrames: number;
  regionFrames: number;
  imageBytes: number;
  imagePixels: number;
  failedActions: number;
  taskDurationMs: number;
  metrics: AgentMetrics;
}

export interface BenchmarkComparison {
  taskId: string;
  taskName: string;
  native: BenchmarkTaskResult;
  adaptive: BenchmarkTaskResult;
  byteReductionPercent: number;
  pixelReductionPercent: number;
  durationDifferenceMs: number;
}

export interface BenchmarkSuiteReport {
  timestamp: string;
  tasks: BenchmarkComparison[];
  summary: {
    totalTasks: number;
    allSucceeded: boolean;
    totalNativeBytes: number;
    totalAdaptiveBytes: number;
    overallByteReductionPercent: number;
    totalNativePixels: number;
    totalAdaptivePixels: number;
    overallPixelReductionPercent: number;
    totalNativeDurationMs: number;
    totalAdaptiveDurationMs: number;
  };
}
