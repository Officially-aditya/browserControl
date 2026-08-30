import { ChromeController } from "../controller.js";
import { VisionModelAdapter, validateVisionDecision } from "../vision/adapter.js";
import { VisionCaptureService, VisionCaptureConfig } from "../vision/capture.js";
import { ObservationPlanner, PlannerOptions } from "../vision/planner.js";
import { VisionFrameMapper } from "../vision/frame-mapper.js";
import { VisionFrame } from "../vision/frame.js";
import { AgentMemory } from "./memory.js";
import { ActionPolicy, ActionPolicyOptions } from "./policy.js";
import { AgentMetrics, MetricsCollector } from "./metrics.js";
import { VisionRequest, VisionDecision } from "../vision/types.js";
import { ActionResult } from "../protocol/results.js";

export interface VisionAgentConfig {
  controller: ChromeController;
  model: VisionModelAdapter;
  policy?: ActionPolicy | ActionPolicyOptions;
  vision?: VisionCaptureConfig & { maxRegionInspectionsPerStep?: number };
  captureConfig?: VisionCaptureConfig;
  plannerOptions?: PlannerOptions;
}

export interface VisionAgentRunOptions {
  objective: string;
  maxSteps?: number;
  initialUrl?: string;
}

export interface VisionAgentRunResult {
  success: boolean;
  objective: string;
  totalSteps: number;
  resultMessage?: string;
  error?: string;
  durationMs: number;
  metrics: AgentMetrics;
}

/**
 * VisionAgent orchestrates the model-agnostic visual computer-use loop:
 * 1. Capture visual frame (Overview or targeted high-detail Region)
 * 2. Formulate compact textual memory summary + visual frame
 * 3. Model decision via standard normalized (0-1000) coordinate protocol
 * 4. Policy safety & precision evaluation
 * 5. Coordinate translation back to browser observation space
 * 6. Execution via ChromeController and feedback loop
 */
export class VisionAgent {
  private controller: ChromeController;
  private model: VisionModelAdapter;
  private captureService: VisionCaptureService;
  private policy: ActionPolicy;
  private plannerOptions?: PlannerOptions;

  constructor(config: VisionAgentConfig) {
    this.controller = config.controller;
    this.model = config.model;
    const captureCfg = { ...config.vision, ...config.captureConfig };
    this.captureService = new VisionCaptureService(config.controller, captureCfg);
    this.policy =
      config.policy instanceof ActionPolicy
        ? config.policy
        : new ActionPolicy(config.policy);
    this.plannerOptions = {
      maxRegionInspectionsPerStep: config.vision?.maxRegionInspectionsPerStep,
      ...config.plannerOptions,
    };
  }

  /**
   * Run the visual agent loop towards an objective
   */
  public async run(options: VisionAgentRunOptions): Promise<VisionAgentRunResult> {
    const startTime = Date.now();
    const maxSteps = options.maxSteps ?? this.plannerOptions?.maxSteps ?? 30;

    const memory = new AgentMemory(options.objective);
    const metrics = new MetricsCollector();
    const planner = new ObservationPlanner({
      maxSteps,
      ...this.plannerOptions,
    });

    if (options.initialUrl) {
      const navStart = Date.now();
      const navRes = await this.controller.executeBrowserAction({
        type: "navigate",
        url: options.initialUrl,
      });
      metrics.recordAction(navRes.success, navRes.durationMs || (Date.now() - navStart), navRes.errorCode);
      memory.setUrl(options.initialUrl);
    }

    let currentOverviewFrame: VisionFrame | null = null;
    let currentActiveFrame: VisionFrame | null = null;
    let lastDecision: VisionDecision | null = null;

    while (!planner.isDone) {
      const step = planner.getNextStep();

      switch (step.nextAction) {
        case "capture_overview": {
          const { observation, frame } = await this.captureService.captureOverview();
          currentOverviewFrame = frame;
          currentActiveFrame = frame;
          metrics.recordFrameCaptured("overview");
          memory.setUrl(observation.url);
          planner.onFrameCaptured(frame);
          break;
        }

        case "capture_region": {
          if (!currentOverviewFrame || !step.region) {
            // If overview is missing, fallback to capturing overview first
            const { frame } = await this.captureService.captureOverview();
            currentOverviewFrame = frame;
            metrics.recordFrameCaptured("overview");
          }
          const regionFrame = await this.captureService.captureRegion(
            step.region!,
            currentOverviewFrame!
          );
          currentActiveFrame = regionFrame;
          metrics.recordFrameCaptured("region");
          planner.onFrameCaptured(regionFrame);
          break;
        }

        case "request_decision": {
          if (!currentActiveFrame) {
            const { frame } = await this.captureService.captureOverview();
            currentOverviewFrame = frame;
            currentActiveFrame = frame;
            metrics.recordFrameCaptured("overview");
          }

          const visionReq: VisionRequest = {
            objective: options.objective,
            frames: [
              {
                image: currentActiveFrame!.image,
                mimeType: currentActiveFrame!.mimeType,
                width: currentActiveFrame!.width,
                height: currentActiveFrame!.height,
                kind: currentActiveFrame!.kind,
                sourceRegion: currentActiveFrame!.sourceRegion,
              },
            ],
            historySummary: memory.formatSummary(),
            currentUrl: this.controller.session.currentUrl || undefined,
            stepIndex: planner.currentStep,
            maxSteps,
          };

          const modelStart = Date.now();
          const rawDecision = await this.model.decide(visionReq);
          const modelLatency = Date.now() - modelStart;
          metrics.recordModelCall(visionReq.frames, modelLatency);

          const decision = validateVisionDecision(rawDecision);
          lastDecision = decision;
          planner.onDecisionReceived(decision);
          break;
        }

        case "execute_action": {
          if (!step.decision || !currentActiveFrame) {
            break;
          }

          const decision = step.decision;

          if (decision.type === "computer_action") {
            const policyEval = await this.policy.evaluate(decision.action, {
              objective: options.objective,
              certainty: decision.certainty || "certain",
              currentUrl: this.controller.session.currentUrl || undefined,
              stepIndex: planner.currentStep,
              frameKind: currentActiveFrame.kind,
              recentActionsCount: memory.totalSteps,
            });

            if (policyEval === "deny") {
              memory.recordStep({
                stepIndex: planner.currentStep,
                actionDescription: `Policy denied action: ${decision.action.type}`,
                intent: decision.intent,
                success: false,
                error: "POLICY_DENIED",
              });
              metrics.recordAction(false, 0, "POLICY_DENIED");
              planner.onActionResult(
                {
                  id: "policy_deny",
                  success: false,
                  action: decision.action.type,
                  error: "Action denied by policy",
                  durationMs: 0,
                },
                decision.action
              );
              break;
            }

            if (policyEval === "inspect" && currentActiveFrame.kind === "overview" && "x" in decision.action) {
              // Trigger inspection around target coordinate
              planner.onDecisionReceived({
                type: "inspect_region",
                region: {
                  x: Math.max(0, Math.min(700, Math.round(decision.action.x - 150))),
                  y: Math.max(0, Math.min(700, Math.round(decision.action.y - 150))),
                  width: 300,
                  height: 300,
                },
                certainty: "uncertain",
                reasoning: "Policy requested inspection before action execution",
              });
              break;
            }

            // Map normalized coordinates into observation coordinates
            const executableAction = VisionFrameMapper.mapNormalizedComputerAction(
              decision.action,
              currentActiveFrame
            );

            const actStart = Date.now();
            const result = await this.controller.executeComputerAction(executableAction);
            const actDuration = result.durationMs || (Date.now() - actStart);
            metrics.recordAction(result.success, actDuration, result.errorCode);

            memory.recordStep({
              stepIndex: planner.currentStep,
              actionDescription: `${decision.action.type}${
                "x" in decision.action ? ` at normalized (${decision.action.x}, ${decision.action.y})` : ""
              }`,
              intent: decision.intent,
              success: result.success,
              error: result.error,
              url: result.url,
            });

            planner.onActionResult(result, decision.action);
          } else if (decision.type === "browser_action") {
            const actStart = Date.now();
            const result = await this.controller.executeBrowserAction(decision.action);
            const actDuration = result.durationMs || (Date.now() - actStart);
            metrics.recordAction(result.success, actDuration, result.errorCode);

            memory.recordStep({
              stepIndex: planner.currentStep,
              actionDescription: `Browser action: ${decision.action.type}${
                "url" in decision.action ? ` -> ${decision.action.url}` : ""
              }`,
              intent: decision.intent,
              success: result.success,
              error: result.error,
              url: result.url,
            });

            planner.onActionResult(result, decision.action);
          }
          break;
        }

        case "done": {
          return {
            success: lastDecision?.type === "done" ? lastDecision.success ?? true : true,
            objective: options.objective,
            totalSteps: planner.currentStep,
            resultMessage: lastDecision?.type === "done" ? lastDecision.result : "Task completed",
            durationMs: Date.now() - startTime,
            metrics: metrics.getMetrics(),
          };
        }

        case "fail": {
          return {
            success: false,
            objective: options.objective,
            totalSteps: planner.currentStep,
            error: step.reason || "Task failed",
            durationMs: Date.now() - startTime,
            metrics: metrics.getMetrics(),
          };
        }
      }
    }

    return {
      success: lastDecision?.type === "done" ? lastDecision.success ?? true : false,
      objective: options.objective,
      totalSteps: planner.currentStep,
      resultMessage: lastDecision?.type === "done" ? lastDecision.result : undefined,
      error: !lastDecision || lastDecision.type !== "done" ? "Terminated without done decision" : undefined,
      durationMs: Date.now() - startTime,
      metrics: metrics.getMetrics(),
    };
  }
}
