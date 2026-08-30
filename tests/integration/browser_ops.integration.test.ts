import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { ChromeController } from "../../src/controller.js";

describe("Live Chrome Browser-Level Operations & Window/Dialog Subsystem", () => {
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

  beforeEach(async () => {
    await controller.resetInputState();
    await controller.navigationController.navigate(`${server.url}/interactive.html`);
    await new Promise((r) => setTimeout(r, 100));
  });

  it("1. list tabs", async () => {
    const tabs = await controller.getTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(1);

    const activeTab = tabs.find((t) => t.attached);
    expect(activeTab).toBeDefined();
    expect(activeTab?.targetId).toBe(controller.currentTargetId);
    expect(activeTab?.url).toContain("interactive.html");
  });

  it("2. new tab", async () => {
    const newTabRes = await controller.executeBrowserAction({
      type: "new_tab",
      url: `${server.url}/calibration.html`,
    });
    expect(newTabRes.success).toBe(true);
    expect(newTabRes.data.targetId).toBeTruthy();

    const tabs = await controller.getTabs();
    const createdTab = tabs.find((t) => t.targetId === newTabRes.data.targetId);
    expect(createdTab).toBeDefined();

    // Clean up
    await controller.executeBrowserAction({
      type: "close_tab",
      targetId: newTabRes.data.targetId,
    });
  });

  it("3. switch tab", async () => {
    const initialTabId = controller.currentTargetId!;

    // Create second tab
    const newTabRes = await controller.executeBrowserAction({
      type: "new_tab",
      url: `${server.url}/calibration.html`,
    });
    const secondTabId = newTabRes.data.targetId;

    // Switch to second tab
    const switchRes = await controller.executeBrowserAction({
      type: "switch_tab",
      targetId: secondTabId,
    });
    expect(switchRes.success).toBe(true);
    expect(controller.currentTargetId).toBe(secondTabId);

    // Switch back to initial tab
    await controller.executeBrowserAction({
      type: "switch_tab",
      targetId: initialTabId,
    });
    expect(controller.currentTargetId).toBe(initialTabId);

    // Clean up second tab
    await controller.executeBrowserAction({
      type: "close_tab",
      targetId: secondTabId,
    });
  });

  it("4. close tab", async () => {
    const newTabRes = await controller.executeBrowserAction({
      type: "new_tab",
      url: `${server.url}/calibration.html`,
    });
    const createdTabId = newTabRes.data.targetId;

    const closeRes = await controller.executeBrowserAction({
      type: "close_tab",
      targetId: createdTabId,
    });
    expect(closeRes.success).toBe(true);
    expect(closeRes.data.closed).toBe(true);

    const tabs = await controller.getTabs();
    expect(tabs.some((t) => t.targetId === createdTabId)).toBe(false);
  });

  it("5. list windows", async () => {
    const windows = await controller.getWindows();
    expect(windows.length).toBeGreaterThanOrEqual(1);

    const win = windows[0];
    expect(typeof win.windowId).toBe("number");
    expect(win.targetIds.length).toBeGreaterThanOrEqual(1);
    expect(win.bounds).toBeDefined();
    expect(win.bounds.width).toBeGreaterThan(0);
    expect(win.bounds.height).toBeGreaterThan(0);
  });

  it("6. new window", async () => {
    const newWinRes = await controller.executeBrowserAction({
      type: "new_window",
      url: `${server.url}/calibration.html`,
    });
    expect(newWinRes.success).toBe(true);
    expect(newWinRes.data.targetId).toBeTruthy();

    const windows = await controller.getWindows();
    expect(windows.length).toBeGreaterThanOrEqual(1);

    // Clean up created window target
    await controller.executeBrowserAction({
      type: "close_tab",
      targetId: newWinRes.data.targetId,
    });
  });

  it("7. activate window", async () => {
    const windows = await controller.getWindows();
    const mainWinId = windows[0].windowId;

    const actRes = await controller.executeBrowserAction({
      type: "activate_window",
      windowId: mainWinId,
    });
    expect(actRes.success).toBe(true);
  });

  it("8. close window", async () => {
    const newWinRes = await controller.executeBrowserAction({
      type: "new_window",
      url: `${server.url}/calibration.html`,
    });
    const newTargetId = newWinRes.data.targetId;

    const windows = await controller.getWindows();
    const newWin = windows.find((w) => w.targetIds.includes(newTargetId));
    expect(newWin).toBeDefined();

    if (newWin) {
      const closeWinRes = await controller.executeBrowserAction({
        type: "close_window",
        windowId: newWin.windowId,
      });
      expect(closeWinRes.success).toBe(true);
      expect(closeWinRes.data.closed).toBe(true);
    }
  });

  async function waitForDialog(expectedType: string, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (controller.activeDialog?.type === expectedType) {
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("9. alert dialog", async () => {
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => document.getElementById('trigger-alert').click(), 20)",
    });
    await waitForDialog("alert");

    expect(controller.activeDialog?.type).toBe("alert");
    expect(controller.activeDialog?.message).toBe("Alert Test Message");

    // Handle alert
    const handleRes = await controller.executeBrowserAction({
      type: "handle_dialog",
      accept: true,
    });
    expect(handleRes.success).toBe(true);
    expect(controller.activeDialog).toBeNull();
  });

  it("10. confirm dialog", async () => {
    // 1. Accept Confirm
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => document.getElementById('trigger-confirm').click(), 20)",
    });
    await waitForDialog("confirm");

    expect(controller.activeDialog?.type).toBe("confirm");
    await controller.executeBrowserAction({ type: "handle_dialog", accept: true });

    let dialogResult = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "window.__STATE__.dialogResult",
      returnByValue: true,
    });
    expect(dialogResult.result.value).toBe("confirm_true");

    // 2. Dismiss Confirm
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => document.getElementById('trigger-confirm').click(), 20)",
    });
    await waitForDialog("confirm");

    expect(controller.activeDialog?.type).toBe("confirm");
    await controller.executeBrowserAction({ type: "handle_dialog", accept: false });

    dialogResult = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "window.__STATE__.dialogResult",
      returnByValue: true,
    });
    expect(dialogResult.result.value).toBe("confirm_false");
  });

  it("11. prompt dialog", async () => {
    // 1. Accept prompt with text
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => document.getElementById('trigger-prompt').click(), 20)",
    });
    await waitForDialog("prompt");

    expect(controller.activeDialog?.type).toBe("prompt");
    await controller.executeBrowserAction({
      type: "handle_dialog",
      accept: true,
      promptText: "Violet",
    });

    let dialogResult = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "window.__STATE__.dialogResult",
      returnByValue: true,
    });
    expect(dialogResult.result.value).toBe("prompt_Violet");

    // 2. Cancel prompt
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => document.getElementById('trigger-prompt').click(), 20)",
    });
    await waitForDialog("prompt");

    expect(controller.activeDialog?.type).toBe("prompt");
    await controller.executeBrowserAction({ type: "handle_dialog", accept: false });

    dialogResult = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "window.__STATE__.dialogResult",
      returnByValue: true,
    });
    expect(dialogResult.result.value).toBe("prompt_cancelled");
  });

  it("12. dialog blocking", async () => {
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => document.getElementById('trigger-alert').click(), 20)",
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(controller.activeDialog).not.toBeNull();

    // Input actions must be rejected with DIALOG_BLOCKING
    const blockedRes = await controller.executeComputerAction({
      type: "click",
      observationId: "obs_any",
      x: 100,
      y: 100,
    });
    expect(blockedRes.success).toBe(false);
    expect(blockedRes.errorCode).toBe("DIALOG_BLOCKING");

    // Unblock dialog
    await controller.executeBrowserAction({ type: "handle_dialog", accept: true });
    expect(controller.activeDialog).toBeNull();
  });
});
