import {
  VisionDecision,
  NormalizedRegion,
  NormalizedComputerAction,
  NormalizedBrowserAction,
} from "./types.js";
import { VisionFrame } from "./frame.js";
import { ActionResult } from "../protocol/results.js";

export type PlannerState =
  | "OVERVIEW"
  | "REGION_INSPECTION"
  | "ACT"
  | "RECOVER"
  | "DONE";

export type PlannerNextActionType =
  | "capture_overview"
  | "capture_region"
  | "request_decision"
  | "execute_action"
  | "done"
  | "fail";

export interface PlannerNextStep {
  nextAction: PlannerNextActionType;
  region?: NormalizedRegion;
  decision?: VisionDecision;
  reason?: string;
}

export interface PlannerOptions {
  maxSteps?: number;
  maxRegionInspectionsPerStep?: number;
}

/**
 * Deterministic visual state machine and observation planner.
 * Manages the transition cycle between Overview perception, high-detail Region Inspection,
 * Action execution, Error Recovery, and Completion.
 */
export class ObservationPlanner {
  private _state: PlannerState = "OVERVIEW";
  private stepIndex = 0;
  private maxSteps: number;
  private maxRegionInspectionsPerStep: number;
  private regionInspectionsThisStep = 0;

  private currentFrame: VisionFrame | null = null;
  private pendingDecision: VisionDecision | null = null;
  private lastFailedSignature: string | null = null;
  private consecutiveSameFailures = 0;
  private lastRecoveryReason: string | null = null;
  private isFinished = false;

  constructor(options: PlannerOptions = {}) {
    this.maxSteps = options.maxSteps ?? 30;
    this.maxRegionInspectionsPerStep = options.maxRegionInspectionsPerStep ?? 2;
  }

  public get state(): PlannerState {
    return this._state;
  }

  public get currentStep(): number {
    return this.stepIndex;
  }

  public get isDone(): boolean {
    return this.isFinished;
  }

  public get activeFrame(): VisionFrame | null {
    return this.currentFrame;
  }

  public get recoveryReason(): string | null {
    return this.lastRecoveryReason;
  }

  /**
   * Reset planner state for a new task objective
   */
  public reset(): void {
    this._state = "OVERVIEW";
    this.stepIndex = 0;
    this.regionInspectionsThisStep = 0;
    this.currentFrame = null;
    this.pendingDecision = null;
    this.lastFailedSignature = null;
    this.consecutiveSameFailures = 0;
    this.lastRecoveryReason = null;
    this.isFinished = false;
  }

  /**
   * Determine the next action the runtime should perform
   */
  public getNextStep(): PlannerNextStep {
    if (this.isFinished || this._state === "DONE") {
      return { nextAction: "done", reason: "Task is completed" };
    }

    if (this.stepIndex >= this.maxSteps) {
      this._state = "DONE";
      this.isFinished = true;
      return { nextAction: "fail", reason: `Maximum steps (${this.maxSteps}) reached` };
    }

    switch (this._state) {
      case "OVERVIEW":
        if (!this.currentFrame) {
          return { nextAction: "capture_overview", reason: "Fresh overview required" };
        }
        return { nextAction: "request_decision", reason: "Ready for model decision on frame" };

      case "REGION_INSPECTION":
        if (!this.pendingDecision || this.pendingDecision.type !== "inspect_region") {
          this._state = "OVERVIEW";
          return { nextAction: "capture_overview", reason: "Inspection region missing, resetting to overview" };
        }
        return {
          nextAction: "capture_region",
          region: this.pendingDecision.region,
          reason: "Capturing high-detail cropped region",
        };

      case "ACT":
        if (!this.pendingDecision) {
          this._state = "OVERVIEW";
          return { nextAction: "capture_overview", reason: "No pending action to execute" };
        }
        return {
          nextAction: "execute_action",
          decision: this.pendingDecision,
          reason: "Executing validated action",
        };

      case "RECOVER":
        return {
          nextAction: "capture_overview",
          reason: `Recovering from: ${this.lastRecoveryReason || "unknown error"}`,
        };
    }
  }

  /**
   * Inform the planner that a visual frame has been captured
   */
  public onFrameCaptured(frame: VisionFrame): void {
    this.currentFrame = frame;
    if (frame.kind === "overview") {
      this._state = "OVERVIEW";
      this.regionInspectionsThisStep = 0;
    } else {
      this._state = "OVERVIEW"; // Ready to request decision on region frame
    }
  }

  /**
   * Process a validated decision from the vision model
   */
  public onDecisionReceived(decision: VisionDecision): PlannerNextStep {
    this.stepIndex++;

    if (decision.type === "done") {
      this._state = "DONE";
      this.isFinished = true;
      this.pendingDecision = decision;
      return { nextAction: "done", decision, reason: decision.result || "Task done" };
    }

    if (decision.type === "inspect_region") {
      if (this.regionInspectionsThisStep >= this.maxRegionInspectionsPerStep) {
        // Exceeded allowed inspections per step: reset to overview to prevent loops
        this._state = "OVERVIEW";
        this.lastRecoveryReason = "MAX_INSPECTIONS_EXCEEDED";
        return { nextAction: "capture_overview", reason: "Max region inspections reached for step, refreshing overview" };
      }
      this.regionInspectionsThisStep++;
      this._state = "REGION_INSPECTION";
      this.pendingDecision = decision;
      return { nextAction: "capture_region", region: decision.region, reason: decision.reasoning };
    }

    if (decision.type === "computer_action" || decision.type === "browser_action") {
      // If decision is marked uncertain and no region inspection has happened, request inspection
      if (decision.certainty === "uncertain" && this.regionInspectionsThisStep === 0 && decision.type === "computer_action" && "x" in decision.action) {
        const action = decision.action as NormalizedComputerAction & { x: number; y: number };
        const inspectionRegion = this.deriveInspectionRegion(action.x, action.y);
        this.regionInspectionsThisStep++;
        this._state = "REGION_INSPECTION";
        this.pendingDecision = {
          type: "inspect_region",
          region: inspectionRegion,
          certainty: "uncertain",
          reasoning: `Uncertain action at (${action.x}, ${action.y}), inspecting region first`,
        };
        return { nextAction: "capture_region", region: inspectionRegion, reason: "Uncertain action inspection" };
      }

      this._state = "ACT";
      this.pendingDecision = decision;
      return { nextAction: "execute_action", decision, reason: "Action ready for execution" };
    }

    this._state = "OVERVIEW";
    return { nextAction: "capture_overview", reason: "Unknown decision type, resetting" };
  }

  /**
   * Process the execution result of an action
   */
  public onActionResult(result: ActionResult, action: NormalizedComputerAction | NormalizedBrowserAction): void {
    const signature = this.computeActionSignature(action);

    if (result.success) {
      this.consecutiveSameFailures = 0;
      this.lastFailedSignature = null;
      this.pendingDecision = null;
      this.currentFrame = null;
      this._state = "OVERVIEW";
      return;
    }

    // Handle Failures
    if (signature === this.lastFailedSignature) {
      this.consecutiveSameFailures++;
    } else {
      this.consecutiveSameFailures = 1;
      this.lastFailedSignature = signature;
    }

    this.pendingDecision = null;
    this.currentFrame = null;
    this._state = "RECOVER";

    if (result.errorCode === "STALE_OBSERVATION") {
      this.lastRecoveryReason = "STALE_OBSERVATION";
    } else if (result.errorCode === "OUT_OF_BOUNDS") {
      this.lastRecoveryReason = "OUT_OF_BOUNDS";
    } else if (result.errorCode === "TARGET_CLOSED") {
      this.lastRecoveryReason = "TARGET_CLOSED";
    } else if (this.consecutiveSameFailures >= 2) {
      this.lastRecoveryReason = "REPEATED_ACTION_FAILURE";
    } else {
      this.lastRecoveryReason = result.error || "ACTION_FAILED";
    }
  }

  /**
   * Notify planner of a target recovery or disconnection recovery event
   */
  public onTargetRecovered(): void {
    this.currentFrame = null;
    this.pendingDecision = null;
    this._state = "RECOVER";
    this.lastRecoveryReason = "TARGET_RECOVERED";
  }

  /**
   * Helper to derive an inspection bounding box centered around a coordinate
   */
  private deriveInspectionRegion(cx: number, cy: number, size = 300): NormalizedRegion {
    const half = size / 2;
    const x = Math.max(0, Math.min(1000 - size, cx - half));
    const y = Math.max(0, Math.min(1000 - size, cy - half));
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: size,
      height: size,
    };
  }

  /**
   * Unique signature string for detecting repeated action failures
   */
  private computeActionSignature(action: NormalizedComputerAction | NormalizedBrowserAction): string {
    if ("x" in action && "y" in action) {
      return `${action.type}_${action.x}_${action.y}`;
    }
    if (action.type === "navigate") {
      return `navigate_${action.url}`;
    }
    if (action.type === "type") {
      return `type_${action.text}`;
    }
    return action.type;
  }
}
