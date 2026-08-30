import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { ChromeController } from "../../src/controller.js";

describe("Live Chrome Genuine Selectorless Computer-Use Verification", () => {
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

  it("should operate pure canvas UI strictly through screenshots, coordinates & computer actions (zero DOM/selectors)", async () => {
    // Navigate to canvas fixture
    await controller.navigationController.navigate(`${server.url}/canvas_ui.html`);
    await new Promise((r) => setTimeout(r, 200));

    // =========================================================================
    // INTERACTION SEQUENCE: 100% VISUAL COMPUTER-USE
    // ZERO DOM selectors, ZERO querySelector, ZERO getBoundingClientRect
    // All coordinates are predetermined visual geometry from the visual canvas fixture
    // =========================================================================

    // Step 1: Capture initial screenshot observation & click canvas button at (170, 102)
    const obs1 = await controller.observe({ showCursor: true });
    expect(obs1.observationId).toBeTruthy();

    const buttonClick = await controller.executeComputerAction({
      type: "click",
      observationId: obs1.observationId,
      x: 170,
      y: 102,
      button: "left",
    });
    expect(buttonClick.success).toBe(true);

    // Step 2: Capture new screenshot observation & hover canvas menu header at (190, 260)
    const obs2 = await controller.observe({ showCursor: true });
    const menuHover = await controller.executeComputerAction({
      type: "move",
      observationId: obs2.observationId,
      x: 190,
      y: 260,
    });
    expect(menuHover.success).toBe(true);
    await new Promise((r) => setTimeout(r, 60));

    // Step 3: Capture new screenshot observation & click revealed menu option 1 at (190, 296)
    const obs3 = await controller.observe({ showCursor: true });
    const menuOptionClick = await controller.executeComputerAction({
      type: "click",
      observationId: obs3.observationId,
      x: 190,
      y: 296,
      button: "left",
    });
    expect(menuOptionClick.success).toBe(true);

    // Step 4: Capture new screenshot observation & click canvas input box at (200, 182)
    const obs4 = await controller.observe({ showCursor: true });
    const inputClick = await controller.executeComputerAction({
      type: "click",
      observationId: obs4.observationId,
      x: 200,
      y: 182,
      button: "left",
    });
    expect(inputClick.success).toBe(true);

    // Step 5: Type text into canvas input field via universal auto method
    const typeRes = await controller.executeComputerAction({
      type: "type",
      text: "CanvasText",
      method: "auto",
    });
    expect(typeRes.success).toBe(true);

    // Step 6: Capture new screenshot observation & drag canvas slider from x:500 to x:650 at y:105
    const obs5 = await controller.observe({ showCursor: true });
    const dragRes = await controller.executeComputerAction({
      type: "drag",
      observationId: obs5.observationId,
      path: [
        { x: 500, y: 105 },
        { x: 550, y: 105 },
        { x: 600, y: 105 },
        { x: 650, y: 105 },
      ],
    });
    expect(dragRes.success).toBe(true);

    // =========================================================================
    // POST-INTERACTION ASSERTIONS (Runtime.evaluate used strictly after sequence)
    // =========================================================================
    const stateEval = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__CANVAS_STATE__",
      returnByValue: true,
    });
    const canvasState = stateEval.result.value;

    expect(canvasState.buttonClicks).toBe(1);
    expect(canvasState.menuSelectedOption).toBe("Option 1: Alpha");
    expect(canvasState.inputText).toBe("CanvasText");
    expect(canvasState.sliderX).toBeGreaterThanOrEqual(640);
  });
});
