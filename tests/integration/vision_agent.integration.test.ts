import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";
import { VisionAgent } from "../../src/agent/runtime.js";
import { VisionModelAdapter } from "../../src/vision/adapter.js";
import { VisionRequest, VisionDecision, VisionCapabilities } from "../../src/vision/types.js";

class ScriptedVisionModel implements VisionModelAdapter {
  readonly id = "scripted-vision-model";
  readonly capabilities: VisionCapabilities = {
    maxImages: 1,
    supportsStructuredOutput: true,
    preferredFormat: "webp",
    preferredLongEdge: 1440,
  };

  private script: VisionDecision[];
  public history: VisionRequest[] = [];

  constructor(script: VisionDecision[]) {
    this.script = [...script];
  }

  public setScript(script: VisionDecision[]): void {
    this.script = [...script];
    this.history = [];
  }

  public async decide(input: VisionRequest): Promise<VisionDecision> {
    this.history.push(input);
    const next = this.script.shift();
    if (!next) {
      return { type: "done", success: true, result: "End of script" };
    }
    return next;
  }
}

describe("Live Chrome Vision Runtime Integration Suite", () => {
  let chrome: LaunchedChrome;
  let server: TestServer;
  let controller: ChromeController;

  beforeAll(async () => {
    server = await startTestServer(0);
    chrome = await launchRealChrome({ windowSize: "1280,800" });
    controller = new ChromeController({
      mode: "ws-endpoint",
      wsEndpoint: chrome.wsUrl,
    });
    await controller.connect();
  }, 20000);

  afterAll(async () => {
    if (controller) await controller.disconnect();
    if (chrome) await chrome.close();
    if (server) await server.close();
  });

  async function evaluateInPage<T>(expression: string): Promise<T> {
    const res = await controller.session.send<{ result: { value: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    return res.result.value;
  }

  // ===========================================================================
  // Case 1: Overview -> Normalized Button Click -> Success
  // ===========================================================================
  it("Case 1: should execute visual button click from normalized overview coordinates", async () => {
    await controller.navigationController.navigate(`${server.url}/interactive.html`);
    await new Promise((r) => setTimeout(r, 200));

    // test-btn is at normalized (68, 151)
    const model = new ScriptedVisionModel([
      {
        type: "computer_action",
        action: { type: "click", x: 68, y: 151, button: "left" },
        certainty: "certain",
        intent: "click test button",
      },
      {
        type: "done",
        success: true,
        result: "Button clicked",
      },
    ]);

    const agent = new VisionAgent({ controller, model });
    const result = await agent.run({
      objective: "Click the primary button",
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(model.history[0].frames[0].kind).toBe("overview");

    const state = await evaluateInPage<any>("window.__STATE__");
    expect(state.clicks).toBeGreaterThanOrEqual(1);
  }, 20000);

  // ===========================================================================
  // Case 2: Overview -> Inspect Region -> Region Frame -> Normalized Crop Click
  // ===========================================================================
  it("Case 2: should inspect region at high resolution and click inside region crop", async () => {
    await controller.navigationController.navigate(`${server.url}/interactive.html`);
    await new Promise((r) => setTimeout(r, 200));

    // Inspect region covering Card 1: normalized { x: 20, y: 80, width: 200, height: 200 }
    // Inside this crop, test-btn (pixel 87, 121) is at:
    // crop starts at (25.6, 64), width 256, height 160
    // normalized inside crop: x = (87 - 25.6)/256 * 1000 = 240, y = (121 - 64)/160 * 1000 = 356
    const model = new ScriptedVisionModel([
      {
        type: "inspect_region",
        region: { x: 20, y: 80, width: 200, height: 200 },
        certainty: "uncertain",
        reasoning: "Zoom in to target button with high resolution",
      },
      {
        type: "computer_action",
        action: { type: "click", x: 240, y: 356, button: "right" },
        certainty: "certain",
        intent: "right click button inside crop",
      },
      {
        type: "done",
        success: true,
        result: "Right-click button activated",
      },
    ]);

    const agent = new VisionAgent({ controller, model });
    const result = await agent.run({
      objective: "Inspect button area and right-click",
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(model.history[0].frames[0].kind).toBe("overview");
    expect(model.history[1].frames[0].kind).toBe("region");

    const state = await evaluateInPage<any>("window.__STATE__");
    expect(state.rightClicks).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("Case 2b: should map nested region inspections back to the original observation", async () => {
    await controller.navigationController.navigate(`${server.url}/interactive.html`);
    await new Promise((r) => setTimeout(r, 200));

    const model = new ScriptedVisionModel([
      {
        type: "inspect_region",
        region: { x: 20, y: 80, width: 200, height: 200 },
        certainty: "uncertain",
        reasoning: "Inspect the first card",
      },
      {
        type: "inspect_region",
        region: { x: 200, y: 300, width: 300, height: 300 },
        certainty: "uncertain",
        reasoning: "Inspect the button inside the card crop",
      },
      {
        type: "computer_action",
        action: { type: "click", x: 133, y: 187, button: "left" },
        certainty: "certain",
        intent: "click the button inside the nested crop",
      },
      { type: "done", success: true, result: "Nested crop click completed" },
    ]);

    const agent = new VisionAgent({ controller, model });
    const result = await agent.run({
      objective: "Inspect a card, inspect its button, then click it",
      maxSteps: 8,
    });

    expect(result.success).toBe(true);
    expect(model.history[1].frames[0].kind).toBe("region");
    expect(model.history[2].frames[0].kind).toBe("region");
    const state = await evaluateInPage<any>("window.__STATE__");
    expect(state.clicks).toBeGreaterThanOrEqual(1);
  }, 20000);

  // ===========================================================================
  // Case 3: Type Text Flow
  // ===========================================================================
  it("Case 3: should focus input and type text through vision runtime", async () => {
    await controller.navigationController.navigate(`${server.url}/interactive.html`);
    await new Promise((r) => setTimeout(r, 200));

    // Input B field at Card 3: normalized (623, 233)
    const model = new ScriptedVisionModel([
      {
        type: "computer_action",
        action: { type: "click", x: 623, y: 233, button: "left" },
        certainty: "certain",
        intent: "focus input b",
      },
      {
        type: "computer_action",
        action: { type: "type", text: "Vision Agent 2026", method: "auto" },
        certainty: "certain",
        intent: "enter text into focused input",
      },
      {
        type: "done",
        success: true,
        result: "Text entered successfully",
      },
    ]);

    const agent = new VisionAgent({ controller, model });
    const result = await agent.run({
      objective: "Type greeting into input B",
      maxSteps: 5,
    });

    expect(result.success).toBe(true);

    const val = await evaluateInPage<string>("document.getElementById('input-b').value");
    expect(val).toBe("Vision Agent 2026");
  }, 20000);

  // ===========================================================================
  // Case 4: Drag Slider Flow
  // ===========================================================================
  it("Case 4: should drag slider knob to change value", async () => {
    await controller.navigationController.navigate(`${server.url}/interactive.html`);
    await new Promise((r) => setTimeout(r, 200));

    // Slider track at Card 2: drag from normalized (273, 368) to (469, 368)
    const model = new ScriptedVisionModel([
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
        intent: "drag slider to increase value",
      },
      {
        type: "done",
        success: true,
        result: "Slider dragged",
      },
    ]);

    const agent = new VisionAgent({ controller, model });
    const result = await agent.run({
      objective: "Drag slider to the right",
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    const sliderVal = await evaluateInPage<number>("Number(document.getElementById('drag-slider').value)");
    expect(sliderVal).toBeGreaterThan(0);
  }, 20000);

  // ===========================================================================
  // Case 5: 100% Canvas-Only Flow
  // ===========================================================================
  it("Case 5: should operate pure canvas UI strictly through vision coordinates", async () => {
    await controller.navigationController.navigate(`${server.url}/canvas_ui.html`);
    await new Promise((r) => setTimeout(r, 200));

    // Canvas button at pixel (170, 102) -> normalized (133, 128)
    const model = new ScriptedVisionModel([
      {
        type: "computer_action",
        action: { type: "click", x: 133, y: 128, button: "left" },
        certainty: "certain",
        intent: "click canvas interactive button",
      },
      {
        type: "done",
        success: true,
        result: "Canvas button clicked",
      },
    ]);

    const agent = new VisionAgent({ controller, model });
    const result = await agent.run({
      objective: "Click canvas button",
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    const state = await evaluateInPage<any>("window.__CANVAS_STATE__");
    expect(state.buttonClicks).toBeGreaterThanOrEqual(1);
  }, 20000);

  // ===========================================================================
  // Case 6: Controlled Tab Closes -> Auto-Recovery -> Continue Task
  // ===========================================================================
  it("Case 6: should recover from external target closure and continue task to completion", async () => {
    // 1. Open background tab
    const bgTab = await controller.tabController.newTab(`${server.url}/interactive.html`, false);
    const controlledTargetId = controller.currentTargetId!;

    let step = 0;
    const model = new ScriptedVisionModel([
      {
        type: "computer_action",
        action: { type: "click", x: 68, y: 151, button: "left" },
        certainty: "certain",
      },
      {
        type: "done",
        success: true,
        result: "Finished after recovery",
      },
    ]);

    // Intercept first decide call to close target externally before action execution
    const originalDecide = model.decide.bind(model);
    model.decide = async (req) => {
      step++;
      if (step === 1) {
        // Destroy the current controlled target
        await controller.connection.send("Target.closeTarget", { targetId: controlledTargetId });
        let elapsed = 0;
        while (controller.session.state !== "TARGET_CLOSED" && elapsed < 3000) {
          await new Promise((r) => setTimeout(r, 50));
          elapsed += 50;
        }
      }
      return originalDecide(req);
    };

    const agent = new VisionAgent({ controller, model });
    const result = await agent.run({
      objective: "Complete task despite target closure",
      maxSteps: 5,
    });

    expect(result.success).toBe(true);
    expect(result.resultMessage).toBe("Finished after recovery");
  }, 25000);
});
