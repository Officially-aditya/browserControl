import { VisionRequestFrame } from "../vision/types.js";

/**
 * Standard performance, cost, perception and execution metrics for a visual task.
 * Completely agnostic to model providers / billing structures.
 */
export interface AgentMetrics {
  /** Number of times the multimodal model was queried */
  modelCalls: number;

  /** Number of full-screen overview frames captured */
  overviewFrames: number;

  /** Number of high-resolution cropped region frames captured */
  regionFrames: number;

  /** Total image pixels sent across all model calls */
  imagePixelsSent: number;

  /** Total image bytes sent across all model calls */
  imageBytesSent: number;

  /** Total browser / computer actions executed */
  actionsExecuted: number;

  /** Number of actions that failed execution */
  failedActions: number;

  /** Number of retries caused by STALE_OBSERVATION */
  staleRetries: number;

  /** Number of high-detail region inspections requested */
  inspections: number;

  /** Cumulative latency spent waiting for model responses (ms) */
  modelLatencyMs: number;

  /** Cumulative latency spent executing browser CDP actions (ms) */
  browserLatencyMs: number;

  /** Total elapsed task runtime duration (ms) */
  totalDurationMs: number;
}

/**
 * Deterministic accumulator for AgentMetrics during visual task execution.
 */
export class MetricsCollector {
  private modelCalls = 0;
  private overviewFrames = 0;
  private regionFrames = 0;
  private imagePixelsSent = 0;
  private imageBytesSent = 0;
  private actionsExecuted = 0;
  private failedActions = 0;
  private staleRetries = 0;
  private inspections = 0;
  private modelLatencyMs = 0;
  private browserLatencyMs = 0;
  private startTime = 0;

  constructor() {
    this.start();
  }

  public start(): void {
    this.startTime = Date.now();
  }

  /**
   * Record a multimodal model call with its frames and latency
   */
  public recordModelCall(frames: VisionRequestFrame[], latencyMs: number): void {
    this.modelCalls++;
    this.modelLatencyMs += latencyMs;
    for (const f of frames) {
      this.imagePixelsSent += f.width * f.height;
      if (f.image) {
        // Calculate raw binary byte length from Base64 string
        const padding = (f.image.endsWith("==") ? 2 : f.image.endsWith("=") ? 1 : 0);
        const byteLen = Math.max(0, Math.floor((f.image.length * 3) / 4) - padding);
        this.imageBytesSent += byteLen;
      }
    }
  }

  /**
   * Record a visual frame capture
   */
  public recordFrameCaptured(kind: "overview" | "region"): void {
    if (kind === "overview") {
      this.overviewFrames++;
    } else {
      this.regionFrames++;
      this.inspections++;
    }
  }

  /**
   * Record an action execution result
   */
  public recordAction(success: boolean, durationMs: number, errorCode?: string): void {
    this.actionsExecuted++;
    this.browserLatencyMs += durationMs;
    if (!success) {
      this.failedActions++;
      if (errorCode === "STALE_OBSERVATION") {
        this.staleRetries++;
      }
    }
  }

  /**
   * Produce final snapshot of metrics
   */
  public getMetrics(): AgentMetrics {
    return {
      modelCalls: this.modelCalls,
      overviewFrames: this.overviewFrames,
      regionFrames: this.regionFrames,
      imagePixelsSent: this.imagePixelsSent,
      imageBytesSent: this.imageBytesSent,
      actionsExecuted: this.actionsExecuted,
      failedActions: this.failedActions,
      staleRetries: this.staleRetries,
      inspections: this.inspections,
      modelLatencyMs: Math.round(this.modelLatencyMs),
      browserLatencyMs: Math.round(this.browserLatencyMs),
      totalDurationMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
    };
  }
}
