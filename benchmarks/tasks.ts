import { ChromeController } from "../src/controller.js";
import { VisionAgent } from "../src/agent/runtime.js";
import { VisionModelAdapter } from "../src/vision/adapter.js";
import { VisionRequest, VisionDecision, VisionCapabilities } from "../src/vision/types.js";
import { BenchmarkMode, BenchmarkTaskResult } from "./types.js";

export interface BenchmarkTaskContext {
  controller: ChromeController;
  serverUrl: string;
}

export interface BenchmarkTaskDefinition {
  id: string;
  name: string;
  run: (mode: BenchmarkMode, ctx: BenchmarkTaskContext) => Promise<BenchmarkTaskResult>;
}

class ScriptedBenchmarkModel implements VisionModelAdapter {
  readonly id = "scripted-benchmark-model";
  readonly capabilities: VisionCapabilities = {
    maxImages: 1,
    supportsStructuredOutput: true,
    preferredFormat: "webp",
  };

  private script: VisionDecision[];

  constructor(script: VisionDecision[]) {
    this.script = [...script];
  }

  public async decide(): Promise<VisionDecision> {
    const next = this.script.shift();
    if (!next) {
      return { type: "done", success: true, result: "End of script" };
    }
    return next;
  }
}

function getVisionConfig(mode: BenchmarkMode) {
  if (mode === "full_native") {
    return {
      overviewFormat: "png" as const,
      overviewQuality: 100,
      regionFormat: "png" as const,
      maxRegionInspectionsPerStep: 0,
    };
  }
  return {
    overviewFormat: "webp" as const,
    overviewQuality: 82,
    overviewLongEdge: 960,
    regionFormat: "png" as const,
    maxRegionInspectionsPerStep: 2,
  };
}

export const benchmarkTasks: BenchmarkTaskDefinition[] = [
  // 1. Click visual button
  {
    id: "task_1_click_button",
    name: "1. Click Visual Button",
    run: async (mode, ctx) => {
      const script: VisionDecision[] = [
        {
          type: "computer_action",
          action: { type: "click", x: 68, y: 151, button: "left" },
          certainty: "certain",
        },
        { type: "done", success: true },
      ];
      const agent = new VisionAgent({
        controller: ctx.controller,
        model: new ScriptedBenchmarkModel(script),
        vision: getVisionConfig(mode),
      });
      const res = await agent.run({
        objective: "Click visual button",
        initialUrl: `${ctx.serverUrl}/interactive.html`,
        maxSteps: 5,
      });
      return {
        taskId: "task_1_click_button",
        taskName: "1. Click Visual Button",
        mode,
        success: res.success,
        steps: res.totalSteps,
        modelCalls: res.metrics.modelCalls,
        overviewFrames: res.metrics.overviewFrames,
        regionFrames: res.metrics.regionFrames,
        imageBytes: res.metrics.imageBytesSent,
        imagePixels: res.metrics.imagePixelsSent,
        failedActions: res.metrics.failedActions,
        taskDurationMs: res.durationMs,
        metrics: res.metrics,
      };
    },
  },

  // 2. Open dropdown and choose item
  {
    id: "task_2_dropdown_select",
    name: "2. Open Dropdown & Select Item",
    run: async (mode, ctx) => {
      const script: VisionDecision[] = [
        {
          type: "computer_action",
          action: { type: "move", x: 80, y: 195 },
          certainty: "certain",
        },
        {
          type: "computer_action",
          action: { type: "click", x: 85, y: 245, button: "left" },
          certainty: "certain",
        },
        { type: "done", success: true },
      ];
      const agent = new VisionAgent({
        controller: ctx.controller,
        model: new ScriptedBenchmarkModel(script),
        vision: getVisionConfig(mode),
      });
      const res = await agent.run({
        objective: "Hover dropdown and select option",
        initialUrl: `${ctx.serverUrl}/interactive.html`,
        maxSteps: 5,
      });
      return {
        taskId: "task_2_dropdown_select",
        taskName: "2. Open Dropdown & Select Item",
        mode,
        success: res.success,
        steps: res.totalSteps,
        modelCalls: res.metrics.modelCalls,
        overviewFrames: res.metrics.overviewFrames,
        regionFrames: res.metrics.regionFrames,
        imageBytes: res.metrics.imageBytesSent,
        imagePixels: res.metrics.imagePixelsSent,
        failedActions: res.metrics.failedActions,
        taskDurationMs: res.durationMs,
        metrics: res.metrics,
      };
    },
  },

  // 3. Type into input
  {
    id: "task_3_type_input",
    name: "3. Type Into Input Field",
    run: async (mode, ctx) => {
      const script: VisionDecision[] = [
        {
          type: "computer_action",
          action: { type: "click", x: 623, y: 233, button: "left" },
          certainty: "certain",
        },
        {
          type: "computer_action",
          action: { type: "type", text: "Benchmarking Vision", method: "auto" },
          certainty: "certain",
        },
        { type: "done", success: true },
      ];
      const agent = new VisionAgent({
        controller: ctx.controller,
        model: new ScriptedBenchmarkModel(script),
        vision: getVisionConfig(mode),
      });
      const res = await agent.run({
        objective: "Focus and type into input",
        initialUrl: `${ctx.serverUrl}/interactive.html`,
        maxSteps: 5,
      });
      return {
        taskId: "task_3_type_input",
        taskName: "3. Type Into Input Field",
        mode,
        success: res.success,
        steps: res.totalSteps,
        modelCalls: res.metrics.modelCalls,
        overviewFrames: res.metrics.overviewFrames,
        regionFrames: res.metrics.regionFrames,
        imageBytes: res.metrics.imageBytesSent,
        imagePixels: res.metrics.imagePixelsSent,
        failedActions: res.metrics.failedActions,
        taskDurationMs: res.durationMs,
        metrics: res.metrics,
      };
    },
  },

  // 4. Multilingual typing
  {
    id: "task_4_multilingual_typing",
    name: "4. Multilingual Unicode Typing",
    run: async (mode, ctx) => {
      const script: VisionDecision[] = [
        {
          type: "computer_action",
          action: { type: "click", x: 623, y: 233, button: "left" },
          certainty: "certain",
        },
        {
          type: "computer_action",
          action: { type: "type", text: "東京 🚀 Привет", method: "auto" },
          certainty: "certain",
        },
        { type: "done", success: true },
      ];
      const agent = new VisionAgent({
        controller: ctx.controller,
        model: new ScriptedBenchmarkModel(script),
        vision: getVisionConfig(mode),
      });
      const res = await agent.run({
        objective: "Type unicode scripts",
        initialUrl: `${ctx.serverUrl}/interactive.html`,
        maxSteps: 5,
      });
      return {
        taskId: "task_4_multilingual_typing",
        taskName: "4. Multilingual Unicode Typing",
        mode,
        success: res.success,
        steps: res.totalSteps,
        modelCalls: res.metrics.modelCalls,
        overviewFrames: res.metrics.overviewFrames,
        regionFrames: res.metrics.regionFrames,
        imageBytes: res.metrics.imageBytesSent,
        imagePixels: res.metrics.imagePixelsSent,
        failedActions: res.metrics.failedActions,
        taskDurationMs: res.durationMs,
        metrics: res.metrics,
      };
    },
  },

  // 5. Drag slider
  {
    id: "task_5_drag_slider",
    name: "5. Drag Slider Track",
    run: async (mode, ctx) => {
      const script: VisionDecision[] = [
        {
          type: "computer_action",
          action: {
            type: "drag",
            path: [
              { x: 273, y: 368 },
              { x: 375, y: 368 },
              { x: 469, y: 368 },
            ],
          },
          certainty: "certain",
        },
        { type: "done", success: true },
      ];
      const agent = new VisionAgent({
        controller: ctx.controller,
        model: new ScriptedBenchmarkModel(script),
        vision: getVisionConfig(mode),
      });
      const res = await agent.run({
        objective: "Drag slider",
        initialUrl: `${ctx.serverUrl}/interactive.html`,
        maxSteps: 5,
      });
      return {
        taskId: "task_5_drag_slider",
        taskName: "5. Drag Slider Track",
        mode,
        success: res.success,
        steps: res.totalSteps,
        modelCalls: res.metrics.modelCalls,
        overviewFrames: res.metrics.overviewFrames,
        regionFrames: res.metrics.regionFrames,
        imageBytes: res.metrics.imageBytesSent,
        imagePixels: res.metrics.imagePixelsSent,
        failedActions: res.metrics.failedActions,
        taskDurationMs: res.durationMs,
        metrics: res.metrics,
      };
    },
  },

  // 6. Canvas-only interaction
  {
    id: "task_6_canvas_interaction",
    name: "6. Non-DOM Canvas Interaction",
    run: async (mode, ctx) => {
      const script: VisionDecision[] = [
        {
          type: "computer_action",
          action: { type: "click", x: 133, y: 128, button: "left" },
          certainty: "certain",
        },
        { type: "done", success: true },
      ];
      const agent = new VisionAgent({
        controller: ctx.controller,
        model: new ScriptedBenchmarkModel(script),
        vision: getVisionConfig(mode),
      });
      const res = await agent.run({
        objective: "Interact with pure canvas button",
        initialUrl: `${ctx.serverUrl}/canvas_ui.html`,
        maxSteps: 5,
      });
      return {
        taskId: "task_6_canvas_interaction",
        taskName: "6. Non-DOM Canvas Interaction",
        mode,
        success: res.success,
        steps: res.totalSteps,
        modelCalls: res.metrics.modelCalls,
        overviewFrames: res.metrics.overviewFrames,
        regionFrames: res.metrics.regionFrames,
        imageBytes: res.metrics.imageBytesSent,
        imagePixels: res.metrics.imagePixelsSent,
        failedActions: res.metrics.failedActions,
        taskDurationMs: res.durationMs,
        metrics: res.metrics,
      };
    },
  },

  // 7. Dialog handling
  {
    id: "task_7_dialog_handling",
    name: "7. Browser Dialog Handling",
    run: async (mode, ctx) => {
      const script: VisionDecision[] = [
        {
          type: "browser_action",
          action: { type: "handle_dialog", accept: true },
          certainty: "certain",
        },
        { type: "done", success: true },
      ];
      const agent = new VisionAgent({
        controller: ctx.controller,
        model: new ScriptedBenchmarkModel(script),
        vision: getVisionConfig(mode),
      });
      const res = await agent.run({
        objective: "Dismiss dialog",
        initialUrl: `${ctx.serverUrl}/interactive.html`,
        maxSteps: 5,
      });
      return {
        taskId: "task_7_dialog_handling",
        taskName: "7. Browser Dialog Handling",
        mode,
        success: res.success,
        steps: res.totalSteps,
        modelCalls: res.metrics.modelCalls,
        overviewFrames: res.metrics.overviewFrames,
        regionFrames: res.metrics.regionFrames,
        imageBytes: res.metrics.imageBytesSent,
        imagePixels: res.metrics.imagePixelsSent,
        failedActions: res.metrics.failedActions,
        taskDurationMs: res.durationMs,
        metrics: res.metrics,
      };
    },
  },

  // 8. Navigation
  {
    id: "task_8_spa_navigation",
    name: "8. SPA Navigation & State Sync",
    run: async (mode, ctx) => {
      const script: VisionDecision[] = [
        {
          type: "browser_action",
          action: { type: "navigate", url: `${ctx.serverUrl}/calibration.html` },
          certainty: "certain",
        },
        {
          type: "browser_action",
          action: { type: "navigate", url: `${ctx.serverUrl}/interactive.html` },
          certainty: "certain",
        },
        { type: "done", success: true },
      ];
      const agent = new VisionAgent({
        controller: ctx.controller,
        model: new ScriptedBenchmarkModel(script),
        vision: getVisionConfig(mode),
      });
      const res = await agent.run({
        objective: "Multi-page navigation",
        initialUrl: `${ctx.serverUrl}/interactive.html`,
        maxSteps: 5,
      });
      return {
        taskId: "task_8_spa_navigation",
        taskName: "8. SPA Navigation & State Sync",
        mode,
        success: res.success,
        steps: res.totalSteps,
        modelCalls: res.metrics.modelCalls,
        overviewFrames: res.metrics.overviewFrames,
        regionFrames: res.metrics.regionFrames,
        imageBytes: res.metrics.imageBytesSent,
        imagePixels: res.metrics.imagePixelsSent,
        failedActions: res.metrics.failedActions,
        taskDurationMs: res.durationMs,
        metrics: res.metrics,
      };
    },
  },

  // 9. Tab recovery
  {
    id: "task_9_tab_recovery",
    name: "9. Target Auto-Recovery",
    run: async (mode, ctx) => {
      const script: VisionDecision[] = [
        {
          type: "computer_action",
          action: { type: "click", x: 68, y: 151, button: "left" },
          certainty: "certain",
        },
        { type: "done", success: true },
      ];
      const agent = new VisionAgent({
        controller: ctx.controller,
        model: new ScriptedBenchmarkModel(script),
        vision: getVisionConfig(mode),
      });
      const res = await agent.run({
        objective: "Recover target and click",
        initialUrl: `${ctx.serverUrl}/interactive.html`,
        maxSteps: 5,
      });
      return {
        taskId: "task_9_tab_recovery",
        taskName: "9. Target Auto-Recovery",
        mode,
        success: res.success,
        steps: res.totalSteps,
        modelCalls: res.metrics.modelCalls,
        overviewFrames: res.metrics.overviewFrames,
        regionFrames: res.metrics.regionFrames,
        imageBytes: res.metrics.imageBytesSent,
        imagePixels: res.metrics.imagePixelsSent,
        failedActions: res.metrics.failedActions,
        taskDurationMs: res.durationMs,
        metrics: res.metrics,
      };
    },
  },

  // 10. Multi-step form (Overview -> Inspect -> Click -> Type -> Done)
  {
    id: "task_10_multistep_form",
    name: "10. Multi-Step Form with Inspection",
    run: async (mode, ctx) => {
      const script: VisionDecision[] = [
        {
          type: "inspect_region",
          region: { x: 500, y: 150, width: 250, height: 150 },
          certainty: "uncertain",
        },
        {
          type: "computer_action",
          action: { type: "click", x: 500, y: 500, button: "left" },
          certainty: "certain",
        },
        {
          type: "computer_action",
          action: { type: "type", text: "MultiStep Completed", method: "auto" },
          certainty: "certain",
        },
        { type: "done", success: true },
      ];
      const agent = new VisionAgent({
        controller: ctx.controller,
        model: new ScriptedBenchmarkModel(script),
        vision: getVisionConfig(mode),
      });
      const res = await agent.run({
        objective: "Inspect form region, focus and fill input",
        initialUrl: `${ctx.serverUrl}/interactive.html`,
        maxSteps: 6,
      });
      return {
        taskId: "task_10_multistep_form",
        taskName: "10. Multi-Step Form with Inspection",
        mode,
        success: res.success,
        steps: res.totalSteps,
        modelCalls: res.metrics.modelCalls,
        overviewFrames: res.metrics.overviewFrames,
        regionFrames: res.metrics.regionFrames,
        imageBytes: res.metrics.imageBytesSent,
        imagePixels: res.metrics.imagePixelsSent,
        failedActions: res.metrics.failedActions,
        taskDurationMs: res.durationMs,
        metrics: res.metrics,
      };
    },
  },
];
