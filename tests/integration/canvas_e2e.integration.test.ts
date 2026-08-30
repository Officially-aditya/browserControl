import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { ChromeController } from "../../src/controller.js";

describe("Live Chrome Canvas E2E — 100% Selectorless Computer-Use Verification", () => {
  let server: TestServer;
  let chrome: LaunchedChrome;
  let controller: ChromeController;

  beforeAll(async () => {
    server = await startTestServer(0);
    chrome = await launchRealChrome({ windowSize: "1280,850" });
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

  it("should operate pure canvas UI through coordinates and keyboard without any DOM selectors", async () => {
    await controller.navigationController.navigate(`${server.url}/canvas_ui.html`);
    await new Promise((r) => setTimeout(r, 200));

    // Get canvas offset in viewport
    const canvasRect = await controller.session.send<{ result: { value: { left: number; top: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('appCanvas').getBoundingClientRect(); return { left: r.left, top: r.top }; })()",
        returnByValue: true,
      }
    );
    const offsetX = canvasRect.result.value.left;
    const offsetY = canvasRect.result.value.top;

    // 1. Initial Observation (obs1)
    const obs1 = await controller.observe();
    expect(obs1.observationId).toBeTruthy();

    // 2. Click Canvas Button (UI.button center at +170, +102)
    const buttonClick = await controller.executeComputerAction({
      type: "click",
      observationId: obs1.observationId,
      x: offsetX + 170,
      y: offsetY + 102,
      button: "left",
    });
    expect(buttonClick.success).toBe(true);

    // 3. New Observation after click (obs2) & Hover Canvas Menu
    const obs2 = await controller.observe();
    const menuHover = await controller.executeComputerAction({
      type: "move",
      observationId: obs2.observationId,
      x: offsetX + 190,
      y: offsetY + 260,
    });
    expect(menuHover.success).toBe(true);
    await new Promise((r) => setTimeout(r, 50));

    // 4. New Observation after move (obs3) & Click Dropdown Option 1 (+190, +296)
    const obs3 = await controller.observe();
    const menuSelect = await controller.executeComputerAction({
      type: "click",
      observationId: obs3.observationId,
      x: offsetX + 190,
      y: offsetY + 296,
      button: "left",
    });
    expect(menuSelect.success).toBe(true);

    // 5. New Observation (obs4) & Focus Canvas Fake Input Box (+200, +182)
    const obs4 = await controller.observe();
    const inputFocus = await controller.executeComputerAction({
      type: "click",
      observationId: obs4.observationId,
      x: offsetX + 200,
      y: offsetY + 182,
      button: "left",
    });
    expect(inputFocus.success).toBe(true);

    // Verify focus right after clicking the input
    const focusEval = await controller.session.send<{ result: { value: boolean } }>("Runtime.evaluate", {
      expression: "window.__CANVAS_STATE__.isInputFocused",
      returnByValue: true,
    });
    expect(focusEval.result.value).toBe(true);

    // 6. Type text into custom canvas listener using default "auto" method
    const typeRes = await controller.executeComputerAction({
      type: "type",
      text: "CanvasText",
      method: "auto",
    });
    expect(typeRes.success).toBe(true);

    // 7. Use keypress Backspace to delete last character from canvas text field
    const backspaceRes = await controller.executeComputerAction({
      type: "keypress",
      keys: ["Backspace"],
    });
    expect(backspaceRes.success).toBe(true);

    // 8. New Observation (obs5) & Drag Canvas Slider Handle from x:500 to x:650
    const obs5 = await controller.observe();
    const dragRes = await controller.executeComputerAction({
      type: "drag",
      observationId: obs5.observationId,
      path: [
        { x: offsetX + 500, y: offsetY + 105 },
        { x: offsetX + 550, y: offsetY + 105 },
        { x: offsetX + 600, y: offsetY + 105 },
        { x: offsetX + 650, y: offsetY + 105 },
      ],
    });
    expect(dragRes.success).toBe(true);

    // 9. Verify Final Canvas Application State via Runtime (Assertion Only)
    const stateEval = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__CANVAS_STATE__",
      returnByValue: true,
    });
    const canvasState = stateEval.result.value;

    expect(canvasState.buttonClicks).toBe(1);
    expect(canvasState.menuSelectedOption).toBe("Option 1: Alpha");
    expect(canvasState.inputText).toBe("CanvasTex"); // "CanvasText" minus 1 Backspace
    expect(canvasState.sliderX).toBeGreaterThanOrEqual(640);
  });
});
