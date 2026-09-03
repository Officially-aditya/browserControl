import { z } from "zod";

const MAX_URL_LENGTH = 2048;
const MAX_TYPE_TEXT = 5000;
const MAX_KEYS = 10;
const MAX_KEY_LENGTH = 50;
const MAX_DRAG_POINTS = 50;

function isHttpHttpsUrl(value: string): boolean {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || /[\x00-\x20]/.test(value)) return false;
  try {
    const protocol = new URL(value.trim()).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isHttpHttpsOrBlank(value: string | undefined): boolean {
  if (value === undefined || value === "about:blank") return true;
  return !!value && isHttpHttpsUrl(value);
}

/**
 * Single internal normalized coordinate system: 0-1000 across X and Y
 */
export const NormalizedCoordinateSchema = z.object({
  x: z.number().min(0, "X coordinate must be >= 0").max(1000, "X coordinate must be <= 1000"),
  y: z.number().min(0, "Y coordinate must be >= 0").max(1000, "Y coordinate must be <= 1000"),
});
export type NormalizedCoordinate = z.infer<typeof NormalizedCoordinateSchema>;

/**
 * Normalized sub-region inside 0-1000 coordinate space
 */
export const NormalizedRegionSchema = z
  .object({
    x: z.number().min(0).max(1000),
    y: z.number().min(0).max(1000),
    width: z.number().min(1).max(1000),
    height: z.number().min(1).max(1000),
  })
  .refine((r) => r.x + r.width <= 1000 && r.y + r.height <= 1000, {
    message: "Region boundaries must stay within 0-1000 space (x + width <= 1000, y + height <= 1000)",
  });
export type NormalizedRegion = z.infer<typeof NormalizedRegionSchema>;

/**
 * Decision certainty level
 */
export const VisionCertaintySchema = z.enum(["certain", "likely", "uncertain"]);
export type VisionCertainty = z.infer<typeof VisionCertaintySchema>;

/**
 * Mouse button types
 */
export const VisionMouseButtonSchema = z.enum(["left", "right", "middle", "back", "forward"]);
export type VisionMouseButton = z.infer<typeof VisionMouseButtonSchema>;

/**
 * Typing method types
 */
export const VisionTypingMethodSchema = z.enum(["auto", "insert_text", "key_events"]);
export type VisionTypingMethod = z.infer<typeof VisionTypingMethodSchema>;

/**
 * Normalized Computer Actions
 */
export const NormalizedClickActionSchema = z.object({
  type: z.literal("click"),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  button: VisionMouseButtonSchema.optional().default("left"),
  modifiers: z.array(z.string()).optional(),
});

export const NormalizedDoubleClickActionSchema = z.object({
  type: z.literal("double_click"),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  button: VisionMouseButtonSchema.optional().default("left"),
  modifiers: z.array(z.string()).optional(),
});

export const NormalizedMoveActionSchema = z.object({
  type: z.literal("move"),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  modifiers: z.array(z.string()).optional(),
});

export const NormalizedMouseDownActionSchema = z.object({
  type: z.literal("down"),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  button: VisionMouseButtonSchema.optional().default("left"),
  modifiers: z.array(z.string()).optional(),
});

export const NormalizedMouseUpActionSchema = z.object({
  type: z.literal("up"),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  button: VisionMouseButtonSchema.optional().default("left"),
  modifiers: z.array(z.string()).optional(),
});

export const NormalizedScrollActionSchema = z.object({
  type: z.literal("scroll"),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  deltaX: z.number().min(-4000).max(4000).optional().default(0),
  deltaY: z.number().min(-4000).max(4000).optional().default(0),
  modifiers: z.array(z.string().max(MAX_KEY_LENGTH)).max(MAX_KEYS).optional(),
});

export const NormalizedDragActionSchema = z.object({
  type: z.literal("drag"),
  path: z.array(NormalizedCoordinateSchema).min(2, "Drag path must have at least 2 points").max(MAX_DRAG_POINTS),
  modifiers: z.array(z.string().max(MAX_KEY_LENGTH)).max(MAX_KEYS).optional(),
});

export const NormalizedKeypressActionSchema = z.object({
  type: z.literal("keypress"),
  keys: z.array(z.string().min(1).max(MAX_KEY_LENGTH)).min(1, "Keypress requires at least one key").max(MAX_KEYS),
});

export const NormalizedKeyDownActionSchema = z.object({
  type: z.literal("key_down"),
  key: z.string().min(1).max(MAX_KEY_LENGTH),
});

export const NormalizedKeyUpActionSchema = z.object({
  type: z.literal("key_up"),
  key: z.string().min(1).max(MAX_KEY_LENGTH),
});

export const NormalizedTypeActionSchema = z.object({
  type: z.literal("type"),
  text: z.string().max(MAX_TYPE_TEXT),
  method: VisionTypingMethodSchema.optional().default("auto"),
});

export const NormalizedWaitActionSchema = z.object({
  type: z.literal("wait"),
  durationMs: z.number().min(0).max(60000).optional().default(1000),
});

export const NormalizedComputerActionSchema = z.discriminatedUnion("type", [
  NormalizedClickActionSchema,
  NormalizedDoubleClickActionSchema,
  NormalizedMoveActionSchema,
  NormalizedMouseDownActionSchema,
  NormalizedMouseUpActionSchema,
  NormalizedScrollActionSchema,
  NormalizedDragActionSchema,
  NormalizedKeypressActionSchema,
  NormalizedKeyDownActionSchema,
  NormalizedKeyUpActionSchema,
  NormalizedTypeActionSchema,
  NormalizedWaitActionSchema,
]);
export type NormalizedComputerAction = z.infer<typeof NormalizedComputerActionSchema>;

/**
 * Normalized Browser Actions
 */
export const NormalizedNavigateActionSchema = z.object({
  type: z.literal("navigate"),
  url: z.string().max(MAX_URL_LENGTH).url("Valid URL required for navigation").refine(isHttpHttpsUrl, {
    message: "Only http:// and https:// URLs are allowed",
  }),
});

export const NormalizedNewTabActionSchema = z.object({
  type: z.literal("new_tab"),
  url: z.string().max(MAX_URL_LENGTH).optional().default("about:blank").refine(isHttpHttpsOrBlank, {
    message: "Only http://, https://, or about:blank URLs are allowed",
  }),
});

export const NormalizedSwitchTabActionSchema = z.object({
  type: z.literal("switch_tab"),
  targetId: z.string(),
});

export const NormalizedCloseTabActionSchema = z.object({
  type: z.literal("close_tab"),
  targetId: z.string().optional(),
});

export const NormalizedBackActionSchema = z.object({
  type: z.literal("back"),
});

export const NormalizedForwardActionSchema = z.object({
  type: z.literal("forward"),
});

export const NormalizedReloadActionSchema = z.object({
  type: z.literal("reload"),
});

export const NormalizedHandleDialogActionSchema = z.object({
  type: z.literal("handle_dialog"),
  accept: z.boolean(),
  promptText: z.string().max(MAX_TYPE_TEXT).optional(),
});

export const NormalizedTabsActionSchema = z.object({
  type: z.literal("tabs"),
});

export const NormalizedWindowsActionSchema = z.object({
  type: z.literal("windows"),
});

export const NormalizedBrowserActionSchema = z.discriminatedUnion("type", [
  NormalizedNavigateActionSchema,
  NormalizedNewTabActionSchema,
  NormalizedSwitchTabActionSchema,
  NormalizedCloseTabActionSchema,
  NormalizedBackActionSchema,
  NormalizedForwardActionSchema,
  NormalizedReloadActionSchema,
  NormalizedHandleDialogActionSchema,
  NormalizedTabsActionSchema,
  NormalizedWindowsActionSchema,
]);
export type NormalizedBrowserAction = z.infer<typeof NormalizedBrowserActionSchema>;

/**
 * Decision Schemas
 */
export const InspectRegionDecisionSchema = z.object({
  type: z.literal("inspect_region"),
  region: NormalizedRegionSchema,
  certainty: VisionCertaintySchema.optional().default("uncertain"),
  reasoning: z.string().optional(),
});
export type InspectRegionDecision = z.infer<typeof InspectRegionDecisionSchema>;

export const ComputerActionDecisionSchema = z.object({
  type: z.literal("computer_action"),
  action: NormalizedComputerActionSchema,
  certainty: VisionCertaintySchema.optional().default("certain"),
  intent: z.string().optional(),
  reasoning: z.string().optional(),
});
export type ComputerActionDecision = z.infer<typeof ComputerActionDecisionSchema>;

export const BrowserActionDecisionSchema = z.object({
  type: z.literal("browser_action"),
  action: NormalizedBrowserActionSchema,
  certainty: VisionCertaintySchema.optional().default("certain"),
  intent: z.string().optional(),
  reasoning: z.string().optional(),
});
export type BrowserActionDecision = z.infer<typeof BrowserActionDecisionSchema>;

export const DoneDecisionSchema = z.object({
  type: z.literal("done"),
  result: z.string().optional(),
  success: z.boolean().optional().default(true),
  certainty: VisionCertaintySchema.optional().default("certain"),
  reasoning: z.string().optional(),
});
export type DoneDecision = z.infer<typeof DoneDecisionSchema>;

export const VisionDecisionSchema = z.discriminatedUnion("type", [
  InspectRegionDecisionSchema,
  ComputerActionDecisionSchema,
  BrowserActionDecisionSchema,
  DoneDecisionSchema,
]);
export type VisionDecision = z.infer<typeof VisionDecisionSchema>;

/**
 * Vision Model Capabilities
 */
export interface VisionCapabilities {
  maxImages: number;
  supportsStructuredOutput: boolean;
  preferredFormat: "png" | "jpeg" | "webp";
  preferredLongEdge?: number;
  supportsHighDetailImages?: boolean;
}

/**
 * Frame payload passed to model adapters
 */
export interface VisionRequestFrame {
  image: string; // base64 encoded
  mimeType: string;
  width: number;
  height: number;
  kind: "overview" | "region";
  sourceRegion?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Request payload sent to VisionModelAdapter.decide()
 */
export interface VisionRequest {
  objective: string;
  frames: VisionRequestFrame[];
  historySummary?: string;
  currentUrl?: string;
  stepIndex?: number;
  maxSteps?: number;
}
