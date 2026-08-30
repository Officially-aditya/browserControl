import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChromeController } from "../../src/controller.js";

// Valid 1000x700 PNG base64
const sample1000x700Png = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0xe8, // 1000
    0x00, 0x00, 0x02, 0xbc, // 700
    0x08, 0x02, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]),
]).toString("base64");

describe("Observation Validity & VisualEpoch Policy Suite", () => {
  let controller: ChromeController;

  beforeEach(async () => {
    controller = new ChromeController({ port: 9222 });

    vi.spyOn(controller.connection, "connect").mockResolvedValue();
    vi.spyOn(controller.connection, "connected", "get").mockReturnValue(true);
    vi.spyOn(controller.targetManager, "init").mockResolvedValue();
    vi.spyOn(controller.targetManager, "listPageTabs").mockResolvedValue([
      { targetId: "tab-1", type: "page", title: "Tab 1", url: "http://127.0.0.1:8080/page1.html", attached: true },
      { targetId: "tab-2", type: "page", title: "Tab 2", url: "http://127.0.0.1:8080/page2.html", attached: true },
    ]);
    vi.spyOn(controller.targetManager, "attachToTarget").mockResolvedValue("session-1");

    vi.spyOn(controller.connection, "send").mockImplementation((method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return Promise.resolve({
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 700, scale: 1 },
          cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 700 },
          cssContentSize: { x: 0, y: 0, width: 1000, height: 700 },
        });
      }
      if (method === "Page.captureScreenshot") {
        return Promise.resolve({ data: sample1000x700Png });
      }
      return Promise.resolve({});
    });

    await controller.connect("tab-1");
  });

  it("1. should reject genuinely stale observations with STALE_OBSERVATION after visual state changes", async () => {
    const obs1 = await controller.observe();
    expect(obs1.observationId).toBeTruthy();

    // Click bumps visualEpoch
    const clickRes = await controller.executeComputerAction({
      type: "click",
      observationId: obs1.observationId,
      x: 150,
      y: 150,
    });
    expect(clickRes.success).toBe(true);

    // Second click using stale obs1 must be rejected
    const staleRes = await controller.executeComputerAction({
      type: "click",
      observationId: obs1.observationId,
      x: 200,
      y: 200,
    });

    expect(staleRes.success).toBe(false);
    expect(staleRes.errorCode).toBe("STALE_OBSERVATION");
  });

  it("2. should reject observations belonging to a different tab with STALE_OBSERVATION", async () => {
    const obsTab1 = await controller.observe();

    // Switch to tab-2
    vi.spyOn(controller.targetManager, "attachToTarget").mockResolvedValue("session-2");
    await controller.tabController.switchTab("tab-2");

    // Action on tab-2 using obsTab1 must fail
    const mismatchRes = await controller.executeComputerAction({
      type: "click",
      observationId: obsTab1.observationId,
      x: 100,
      y: 100,
    });

    expect(mismatchRes.success).toBe(false);
    expect(mismatchRes.errorCode).toBe("STALE_OBSERVATION");
  });

  it("3. should reject out-of-bounds coordinates with OUT_OF_BOUNDS", async () => {
    const obs = await controller.observe();

    const outX = await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: 1500, // Image width is 1000
      y: 200,
    });
    expect(outX.success).toBe(false);
    expect(outX.errorCode).toBe("OUT_OF_BOUNDS");

    const outY = await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: 200,
      y: -50,
    });
    expect(outY.success).toBe(false);
    expect(outY.errorCode).toBe("OUT_OF_BOUNDS");
  });

  it("4. should keep observation valid for non-invalidating actions (key_down, move, down/up sequence)", async () => {
    const obs = await controller.observe();

    // 1. key_down Shift does not invalidate observation
    await controller.executeComputerAction({ type: "key_down", key: "Shift" });

    // 2. move cursor with obs
    const moveRes = await controller.executeComputerAction({
      type: "move",
      observationId: obs.observationId,
      x: 300,
      y: 200,
    });
    expect(moveRes.success).toBe(true);

    // 3. down with obs
    const downRes = await controller.executeComputerAction({
      type: "down",
      observationId: obs.observationId,
      x: 300,
      y: 200,
    });
    expect(downRes.success).toBe(true);

    // 4. up with obs
    const upRes = await controller.executeComputerAction({
      type: "up",
      observationId: obs.observationId,
      x: 300,
      y: 200,
    });
    expect(upRes.success).toBe(true);

    // 5. key_up Shift
    await controller.executeComputerAction({ type: "key_up", key: "Shift" });
  });

  it("5. should invalidate old observations on page navigation and reload", async () => {
    const obsBeforeNav = await controller.observe();

    // Mock navigation resolution and execute navigation action
    vi.spyOn(controller.navigationController, "navigate").mockImplementation(async () => {
      controller.session.bumpVisualEpoch();
    });

    await controller.executeBrowserAction({
      type: "navigate",
      url: "http://127.0.0.1:8080/page2.html",
    });

    // Action with obsBeforeNav must be rejected
    const res = await controller.executeComputerAction({
      type: "click",
      observationId: obsBeforeNav.observationId,
      x: 100,
      y: 100,
    });

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("STALE_OBSERVATION");
  });
});
