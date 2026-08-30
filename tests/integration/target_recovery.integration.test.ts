import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { ChromeController } from "../../src/controller.js";

describe("Live Chrome Automatic Controlled Target Recovery", () => {
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

  it("should automatically recover and switch to remaining tab when controlled tab is closed externally", async () => {
    // 1. Create a second tab
    const tab2 = await controller.tabController.newTab(`${server.url}/calibration.html`, true);
    const initialTargetId = controller.currentTargetId;
    expect(initialTargetId).toBe(tab2.targetId);

    // 2. Close the controlled tab via raw CDP Target.closeTarget (simulating external user action)
    await controller.connection.send("Target.closeTarget", { targetId: initialTargetId! });

    // Wait briefly for recovery
    await new Promise((r) => setTimeout(r, 200));

    // 3. Controller should have automatically recovered to another open tab
    expect(controller.isConnected).toBe(true);
    expect(controller.currentTargetId).toBeTruthy();
    expect(controller.currentTargetId).not.toBe(initialTargetId);

    // 4. observe() should work immediately without errors
    const obs = await controller.observe();
    expect(obs.observationId).toBeTruthy();
    expect(obs.imageWidth).toBeGreaterThan(0);
  }, 20000);

  it("should automatically create and attach to a new about:blank tab when the ONLY open tab is closed", async () => {
    // 1. Close all tabs except the active one
    const allTabs = await controller.getTabs();
    for (let i = 1; i < allTabs.length; i++) {
      await controller.connection.send("Target.closeTarget", { targetId: allTabs[i].targetId }).catch(() => {});
    }

    const currentTabId = controller.currentTargetId!;

    // 2. Close the ONLY remaining open tab
    await controller.connection.send("Target.closeTarget", { targetId: currentTabId });

    // Wait for auto-recovery to create and attach to a new tab
    const start = Date.now();
    while ((!controller.currentTargetId || controller.currentTargetId === currentTabId) && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // 3. Controller should have automatically created a new about:blank tab and attached to it
    expect(controller.isConnected).toBe(true);
    expect(controller.currentTargetId).toBeTruthy();
    expect(controller.currentTargetId).not.toBe(currentTabId);

    // 4. Executing computer and browser actions should function normally
    const obs = await controller.observe();
    expect(obs.observationId).toBeTruthy();

    const navRes = await controller.executeBrowserAction({
      type: "navigate",
      url: `${server.url}/interactive.html`,
    });
    expect(navRes.success).toBe(true);
  }, 20000);

  it("should invalidate observations from closed target and reject stale actions on recovered target", async () => {
    // 1. Capture observation on current tab
    const initialObs = await controller.observe();
    const initialTargetId = controller.currentTargetId!;

    // 2. Close the target externally
    await controller.connection.send("Target.closeTarget", { targetId: initialTargetId });

    // Wait for session state transition
    let elapsed = 0;
    while (controller.session.state !== "TARGET_CLOSED" && elapsed < 3000) {
      await new Promise((r) => setTimeout(r, 50));
      elapsed += 50;
    }

    // Trigger auto-recovery
    await controller.ensureActiveSession();

    expect(controller.currentTargetId).not.toBe(initialTargetId);

    // 3. Trying to act using the old observationId must be rejected with STALE_OBSERVATION
    const actRes = await controller.executeComputerAction({
      type: "click",
      observationId: initialObs.observationId,
      x: 100,
      y: 100,
    });

    expect(actRes.success).toBe(false);
    expect(actRes.errorCode).toBe("STALE_OBSERVATION");
  }, 20000);
});
