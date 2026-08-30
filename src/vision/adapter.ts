import {
  VisionCapabilities,
  VisionRequest,
  VisionDecision,
  VisionDecisionSchema,
} from "./types.js";

/**
 * Base interface for all vision model adapters (OpenAI, Anthropic, Gemini, local VLMs, custom callbacks).
 * Model adapters communicate purely through normalized 0-1000 coordinates and standard VisionDecision types.
 */
export interface VisionModelAdapter {
  readonly id: string;
  readonly capabilities: VisionCapabilities;

  /**
   * Produce a decision for the current visual step given objective, frames, and memory summary.
   */
  decide(input: VisionRequest): Promise<VisionDecision>;
}

/**
 * Parse and validate a raw vision decision object from any model output.
 * Throws an informative error if the decision violates the protocol or bounds.
 */
export function validateVisionDecision(raw: unknown): VisionDecision {
  const result = VisionDecisionSchema.safeParse(raw);
  if (!result.success) {
    const errorDetails = result.error.errors
      .map((e) => `${e.path.join(".") || "root"}: ${e.message}`)
      .join("; ");
    throw new Error(`Invalid VisionDecision payload: ${errorDetails}`);
  }
  return result.data;
}

/**
 * Safely parse a raw vision decision object, returning a typed result object.
 */
export function safeValidateVisionDecision(raw: unknown): {
  success: true;
  data: VisionDecision;
} | {
  success: false;
  error: string;
} {
  const result = VisionDecisionSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errorDetails = result.error.errors
    .map((e) => `${e.path.join(".") || "root"}: ${e.message}`)
    .join("; ");
  return { success: false, error: `Invalid VisionDecision payload: ${errorDetails}` };
}
