import {
  VisionCertainty,
  NormalizedComputerAction,
  NormalizedBrowserAction,
} from "../vision/types.js";

export type PolicyEvaluation =
  | "allow"
  | "inspect"
  | "require_confirmation"
  | "deny";

export interface ActionPolicyContext {
  objective: string;
  certainty: VisionCertainty;
  currentUrl?: string;
  stepIndex: number;
  frameKind: "overview" | "region";
  recentActionsCount: number;
  customData?: Record<string, any>;
}

export type ActionPolicyHook = (
  action: NormalizedComputerAction | NormalizedBrowserAction,
  context: ActionPolicyContext
) => PolicyEvaluation | Promise<PolicyEvaluation>;

export interface ActionPolicyOptions {
  /**
   * Custom application policy hook called before evaluating default certainty rules.
   */
  beforeAction?: ActionPolicyHook;

  /**
   * Action types considered precision-sensitive on overview frames when certainty is "likely".
   * Default: ["drag", "double_click"]
   */
  precisionSensitiveActions?: string[];

  /**
   * Whether to strictly require inspection for uncertain actions on overview frames.
   * Default: true
   */
  requireInspectOnUncertain?: boolean;
}

/**
 * ActionPolicy enforces safety, precision, and verification rules before actions are executed.
 * Operates purely on certainty levels ("certain", "likely", "uncertain") and custom policy hooks.
 */
export class ActionPolicy {
  private options: ActionPolicyOptions;
  private precisionSensitiveActions: Set<string>;

  constructor(options: ActionPolicyOptions = {}) {
    this.options = options;
    this.precisionSensitiveActions = new Set(
      options.precisionSensitiveActions ?? ["drag", "double_click"]
    );
  }

  /**
   * Evaluate whether an action is permitted, requires region inspection, needs user confirmation, or is denied.
   */
  public async evaluate(
    action: NormalizedComputerAction | NormalizedBrowserAction,
    context: ActionPolicyContext
  ): Promise<PolicyEvaluation> {
    // 1. Custom application hook takes precedence if provided
    if (this.options.beforeAction) {
      const customDecision = await this.options.beforeAction(action, context);
      if (customDecision !== "allow") {
        return customDecision;
      }
    }

    // 2. Default certainty-driven policy rules
    const certainty = context.certainty;

    if (certainty === "certain") {
      return "allow";
    }

    if (certainty === "uncertain") {
      // Uncertain actions cannot execute directly; must inspect region first
      if (context.frameKind === "overview" && this.options.requireInspectOnUncertain !== false) {
        return "inspect";
      }
      return "inspect";
    }

    if (certainty === "likely") {
      // Allow ordinary actions; inspect for precision-sensitive actions on overview frames
      if (this.precisionSensitiveActions.has(action.type) && context.frameKind === "overview") {
        return "inspect";
      }
      return "allow";
    }

    return "allow";
  }
}
