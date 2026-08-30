import { describe, it, expect, vi } from "vitest";
import { ChromeController } from "../../src/controller.js";

// Valid 1000x700 PNG buffer base64
const sample1000x700Png = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x03, 0xe8, // Width: 1000
    0x00, 0x00, 0x02, 0xbc, // Height: 700
    0x08, 0x02, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // CRC placeholder
  ]),
]).toString("base64");

describe("Visual Computer-Use Loop & Controller E2E", () => {
  it("should execute full computer-use action loop sequentially", async () => {
    const controller = new ChromeController({ port: 9222 });

    const cdpCalls: Array<{ method: string; params: any; sessionId?: string }> = [];

    vi.spyOn(controller.connection, "connect").mockResolvedValue();
    vi.spyOn(controller.connection, "connected", "get").mockReturnValue(true);
    vi.spyOn(controller.targetManager, "init").mockResolvedValue();
    vi.spyOn(controller.targetManager, "listPageTabs").mockResolvedValue([
      {
        targetId: "tab-canvas-1",
        type: "page",
        title: "Pure Canvas UI",
        url: "http://127.0.0.1:8080/canvas_ui.html",
        attached: true,
      },
    ]);
    vi.spyOn(controller.targetManager, "attachToTarget").mockResolvedValue("session-canvas-1");

    vi.spyOn(controller.connection, "send").mockImplementation((method: string, params?: any, sessionId?: string) => {
      cdpCalls.push({ method, params, sessionId });

      if (method === "Page.getLayoutMetrics") {
        return Promise.resolve({
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 700, scale: 1 },
          cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 700 },
          cssContentSize: { x: 0, y: 0, width: 1000, height: 700 },
        });
      }

      if (method === "Page.captureScreenshot") {
        return Promise.resolve({
          data: sample1000x700Png,
        });
      }

      if (method === "Runtime.evaluate") {
        return Promise.resolve({ result: { value: 1 } });
      }

      return Promise.resolve({});
    });

    // 1. Connect
    await controller.connect();
    expect(controller.state).toBe("READY");

    // 2. Step 1: Capture Screenshot (Observe)
    const obs = await controller.observe();
    expect(obs.viewportWidth).toBe(1000);
    expect(obs.viewportHeight).toBe(700);
    expect(obs.imageWidth).toBe(1000);
    expect(obs.imageHeight).toBe(700);
    expect(obs.image).toBeTruthy();
    expect(obs.coordinateSpace.scaleX).toBe(1);

    // 3. Step 2: Click Button at (170, 102)
    const clickRes = await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: 170,
      y: 102,
      button: "left",
    });
    expect(clickRes.success).toBe(true);
    expect(clickRes.action).toBe("click");

    // 4. Step 3: Hover over dropdown menu at (150, 260)
    const moveRes = await controller.executeComputerAction({
      type: "move",
      x: 150,
      y: 260,
    });
    expect(moveRes.success).toBe(true);

    // 5. Step 4: Focus input box at (150, 180) and Type "Test Agent"
    const focusRes = await controller.executeComputerAction({
      type: "click",
      x: 150,
      y: 180,
    });
    expect(focusRes.success).toBe(true);

    const typeRes = await controller.executeComputerAction({
      type: "type",
      text: "Test Agent",
    });
    expect(typeRes.success).toBe(true);

    // 6. Step 5: Drag slider handle from (500, 105) to (650, 105)
    const dragRes = await controller.executeComputerAction({
      type: "drag",
      path: [
        { x: 500, y: 105 },
        { x: 550, y: 105 },
        { x: 600, y: 105 },
        { x: 650, y: 105 },
      ],
    });
    expect(dragRes.success).toBe(true);

    // 7. Step 6: Select all text via keypress Meta+A
    const keypressRes = await controller.executeComputerAction({
      type: "keypress",
      keys: ["Meta", "A"],
    });
    expect(keypressRes.success).toBe(true);

    // 8. Step 7: Final Screenshot Observation
    const finalObs = await controller.observe();
    expect(finalObs.viewportWidth).toBe(1000);
    expect(finalObs.viewportHeight).toBe(700);

    // Verify CDP call sequence
    const mouseMoves = cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params?.type === "mouseMoved");
    expect(mouseMoves.length).toBeGreaterThanOrEqual(5);

    const inserts = cdpCalls.filter((c) => c.method === "Input.insertText");
    expect(inserts.length).toBe(1);
    expect(inserts[0].params.text).toBe("Test Agent");
  });
});
