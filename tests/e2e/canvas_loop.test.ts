import { describe, it, expect, vi } from "vitest";
import { ChromeController } from "../../src/controller.js";

const sample1000x700Png = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0xe8,
    0x00, 0x00, 0x02, 0xbc,
    0x08, 0x02, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]),
]).toString("base64");

describe("Visual Computer-Use Loop & Controller E2E", () => {
  it("should execute full computer-use action loop sequentially with observationId validation", async () => {
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
    const obs1 = await controller.observe();
    expect(obs1.viewportWidth).toBe(1000);
    expect(obs1.viewportHeight).toBe(700);
    expect(obs1.imageWidth).toBe(1000);
    expect(obs1.imageHeight).toBe(700);
    expect(obs1.coordinateSpace.scaleX).toBe(1);

    // 3. Step 2: Click Button at (170, 102) using obs1
    const clickRes = await controller.executeComputerAction({
      type: "click",
      observationId: obs1.observationId,
      x: 170,
      y: 102,
      button: "left",
    });
    expect(clickRes.success).toBe(true);

    // 4. Step 3: Observe after click to get new observationId (obs2)
    const obs2 = await controller.observe();

    // 5. Step 4: Hover over dropdown menu at (150, 260) using obs2
    const moveRes = await controller.executeComputerAction({
      type: "move",
      observationId: obs2.observationId,
      x: 150,
      y: 260,
    });
    expect(moveRes.success).toBe(true);

    // 6. Step 5: Observe & Focus input box at (150, 180) & Type text
    const obs3 = await controller.observe();
    const focusRes = await controller.executeComputerAction({
      type: "click",
      observationId: obs3.observationId,
      x: 150,
      y: 180,
    });
    expect(focusRes.success).toBe(true);

    const typeRes = await controller.executeComputerAction({
      type: "type",
      text: "Test Agent",
      method: "key_events",
    });
    expect(typeRes.success).toBe(true);

    // 7. Step 6: Observe & Drag slider handle
    const obs4 = await controller.observe();
    const dragRes = await controller.executeComputerAction({
      type: "drag",
      observationId: obs4.observationId,
      path: [
        { x: 500, y: 105 },
        { x: 550, y: 105 },
        { x: 600, y: 105 },
        { x: 650, y: 105 },
      ],
    });
    expect(dragRes.success).toBe(true);

    // 8. Step 7: Select all text via keypress Meta+A
    const keypressRes = await controller.executeComputerAction({
      type: "keypress",
      keys: ["Meta", "A"],
    });
    expect(keypressRes.success).toBe(true);

    // 9. Step 8: Final Screenshot Observation
    const finalObs = await controller.observe();
    expect(finalObs.viewportWidth).toBe(1000);
    expect(finalObs.viewportHeight).toBe(700);

    const mouseMoves = cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params?.type === "mouseMoved");
    expect(mouseMoves.length).toBeGreaterThanOrEqual(5);
  });
});
