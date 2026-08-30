import { z } from "zod";

export const CoordinateSchema = z.object({
  x: z.number().describe("X coordinate in screenshot image pixels"),
  y: z.number().describe("Y coordinate in screenshot image pixels"),
});
export type Coordinate = z.infer<typeof CoordinateSchema>;

export const MouseButtonSchema = z.enum(["left", "right", "middle", "back", "forward"]);
export type MouseButton = z.infer<typeof MouseButtonSchema>;

export const TypingMethodSchema = z.enum(["auto", "insert_text", "key_events"]);
export type TypingMethod = z.infer<typeof TypingMethodSchema>;

export const ScreenshotActionSchema = z.object({
  type: z.literal("screenshot"),
  format: z.enum(["png", "jpeg", "webp"]).optional().default("png"),
  showCursor: z.boolean().optional(),
});

export const MoveActionSchema = z.object({
  type: z.literal("move"),
  observationId: z.string().describe("The observationId of the screenshot this action was planned against"),
  x: z.number(),
  y: z.number(),
  modifiers: z.array(z.string()).optional(),
});

export const ClickActionSchema = z.object({
  type: z.literal("click"),
  observationId: z.string().describe("The observationId of the screenshot this action was planned against"),
  x: z.number(),
  y: z.number(),
  button: MouseButtonSchema.optional().default("left"),
  modifiers: z.array(z.string()).optional(),
});

export const DoubleClickActionSchema = z.object({
  type: z.literal("double_click"),
  observationId: z.string().describe("The observationId of the screenshot this action was planned against"),
  x: z.number(),
  y: z.number(),
  button: MouseButtonSchema.optional().default("left"),
  modifiers: z.array(z.string()).optional(),
});

export const MouseDownActionSchema = z.object({
  type: z.literal("down"),
  observationId: z.string().describe("The observationId of the screenshot this action was planned against"),
  x: z.number(),
  y: z.number(),
  button: MouseButtonSchema.optional().default("left"),
  modifiers: z.array(z.string()).optional(),
});

export const MouseUpActionSchema = z.object({
  type: z.literal("up"),
  observationId: z.string().describe("The observationId of the screenshot this action was planned against"),
  x: z.number(),
  y: z.number(),
  button: MouseButtonSchema.optional().default("left"),
  modifiers: z.array(z.string()).optional(),
});

export const ScrollActionSchema = z.object({
  type: z.literal("scroll"),
  observationId: z.string().describe("The observationId of the screenshot this action was planned against"),
  x: z.number(),
  y: z.number(),
  deltaX: z.number().optional().default(0),
  deltaY: z.number().optional().default(0),
  modifiers: z.array(z.string()).optional(),
});

export const DragActionSchema = z.object({
  type: z.literal("drag"),
  observationId: z.string().describe("The observationId of the screenshot this action was planned against"),
  path: z.array(CoordinateSchema).min(2, "Drag path must have at least 2 points (start and end)"),
  modifiers: z.array(z.string()).optional(),
});

export const KeypressActionSchema = z.object({
  type: z.literal("keypress"),
  keys: z.array(z.string()).min(1, "Keypress requires at least one key"),
});

export const KeyDownActionSchema = z.object({
  type: z.literal("key_down"),
  key: z.string(),
});

export const KeyUpActionSchema = z.object({
  type: z.literal("key_up"),
  key: z.string(),
});

export const TypeActionSchema = z.object({
  type: z.literal("type"),
  text: z.string(),
  method: TypingMethodSchema.optional().default("auto"),
});

export const ResetInputActionSchema = z.object({
  type: z.literal("reset_input"),
});

export const WaitActionSchema = z.object({
  type: z.literal("wait"),
  ms: z.number().nonnegative(),
});

export const ComputerActionSchema = z.discriminatedUnion("type", [
  ScreenshotActionSchema,
  MoveActionSchema,
  ClickActionSchema,
  DoubleClickActionSchema,
  MouseDownActionSchema,
  MouseUpActionSchema,
  ScrollActionSchema,
  DragActionSchema,
  KeypressActionSchema,
  KeyDownActionSchema,
  KeyUpActionSchema,
  TypeActionSchema,
  ResetInputActionSchema,
  WaitActionSchema,
]);

export type ComputerAction = z.infer<typeof ComputerActionSchema>;

export const NavigateActionSchema = z.object({
  type: z.literal("navigate"),
  url: z.string().url("Must be a valid URL"),
});

export const NewTabActionSchema = z.object({
  type: z.literal("new_tab"),
  url: z.string().url().optional(),
});

export const SwitchTabActionSchema = z.object({
  type: z.literal("switch_tab"),
  targetId: z.string(),
});

export const CloseTabActionSchema = z.object({
  type: z.literal("close_tab"),
  targetId: z.string(),
});

export const BackActionSchema = z.object({
  type: z.literal("back"),
});

export const ForwardActionSchema = z.object({
  type: z.literal("forward"),
});

export const ReloadActionSchema = z.object({
  type: z.literal("reload"),
});

export const ListTabsActionSchema = z.object({
  type: z.literal("tabs"),
});

export const ListWindowsActionSchema = z.object({
  type: z.literal("windows"),
});

export const NewWindowActionSchema = z.object({
  type: z.literal("new_window"),
  url: z.string().url().optional(),
});

export const ActivateWindowActionSchema = z.object({
  type: z.literal("activate_window"),
  windowId: z.number(),
});

export const CloseWindowActionSchema = z.object({
  type: z.literal("close_window"),
  windowId: z.number(),
});

export const DialogStateActionSchema = z.object({
  type: z.literal("dialog_state"),
});

export const HandleDialogActionSchema = z.object({
  type: z.literal("handle_dialog"),
  accept: z.boolean(),
  promptText: z.string().optional(),
});

export const BrowserActionSchema = z.discriminatedUnion("type", [
  NavigateActionSchema,
  NewTabActionSchema,
  SwitchTabActionSchema,
  CloseTabActionSchema,
  BackActionSchema,
  ForwardActionSchema,
  ReloadActionSchema,
  ListTabsActionSchema,
  ListWindowsActionSchema,
  NewWindowActionSchema,
  ActivateWindowActionSchema,
  CloseWindowActionSchema,
  DialogStateActionSchema,
  HandleDialogActionSchema,
]);

export type BrowserAction = z.infer<typeof BrowserActionSchema>;
