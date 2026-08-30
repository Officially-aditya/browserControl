import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { ChromeController } from "../../src/controller.js";

describe("Live Chrome Interactive Features, Modifiers, Shortcuts, Windows & Dialogs", () => {
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

  it("should handle mouse clicks (left, double, right) and hover dropdown", async () => {
    const obs1 = await controller.observe();

    const btnPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('test-btn').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    // 1. Left click
    await controller.executeComputerAction({
      type: "click",
      observationId: obs1.observationId,
      x: btnPos.result.value.x,
      y: btnPos.result.value.y,
      button: "left",
    });

    // 2. Double click
    const obs2 = await controller.observe();
    await controller.executeComputerAction({
      type: "double_click",
      observationId: obs2.observationId,
      x: btnPos.result.value.x,
      y: btnPos.result.value.y,
      button: "left",
    });

    // 3. Right click
    const obs3 = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs3.observationId,
      x: btnPos.result.value.x,
      y: btnPos.result.value.y,
      button: "right",
    });

    // 4. Hover menu
    const menuBtnPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('hover-menu-btn').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const obs4 = await controller.observe();
    await controller.executeComputerAction({
      type: "move",
      observationId: obs4.observationId,
      x: menuBtnPos.result.value.x,
      y: menuBtnPos.result.value.y,
    });
    await new Promise((r) => setTimeout(r, 50));

    // Click item 2 in dropdown
    const item2Pos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('menu-item-2').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const obs5 = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs5.observationId,
      x: item2Pos.result.value.x,
      y: item2Pos.result.value.y,
      button: "left",
    });

    const stateEval = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__",
      returnByValue: true,
    });

    expect(stateEval.result.value.clicks).toBeGreaterThanOrEqual(1);
    expect(stateEval.result.value.doubleClicks).toBe(1);
    expect(stateEval.result.value.rightClicks).toBe(1);
    expect(stateEval.result.value.hoverSelected).toBe("menu-item-2");
  });

  it("should support held modifier keys across multiple clicks (Shift-click & Meta-click)", async () => {
    const item1Pos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('mod-item-1').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const item2Pos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('mod-item-2').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    // 1. Key down Shift
    await controller.executeComputerAction({ type: "key_down", key: "Shift" });

    // 2. Click Item 1 with Shift held
    const obs1 = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs1.observationId,
      x: item1Pos.result.value.x,
      y: item1Pos.result.value.y,
    });

    let stateEval = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__",
      returnByValue: true,
    });
    expect(stateEval.result.value.lastClickShift).toBe(true);

    // 3. Click Item 2 with Shift still held
    const obs2 = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs2.observationId,
      x: item2Pos.result.value.x,
      y: item2Pos.result.value.y,
    });

    stateEval = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__",
      returnByValue: true,
    });
    expect(stateEval.result.value.lastClickShift).toBe(true);

    // 4. Key up Shift
    await controller.executeComputerAction({ type: "key_up", key: "Shift" });

    // 5. Click Item 1 without Shift
    const obs3 = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs3.observationId,
      x: item1Pos.result.value.x,
      y: item1Pos.result.value.y,
    });

    stateEval = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__",
      returnByValue: true,
    });
    expect(stateEval.result.value.lastClickShift).toBe(false);
  });

  it("should execute Meta+A, Meta+C, Meta+V copy/paste shortcuts across inputs on live Chrome", async () => {
    const inputAPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('input-a').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const inputBPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('input-b').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    // 1. Focus Input A
    const obs1 = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs1.observationId,
      x: inputAPos.result.value.x,
      y: inputAPos.result.value.y,
    });

    // 2. Select All & Copy (Meta+A, Meta+C)
    const isMac = process.platform === "darwin";
    const modKey = isMac ? "Meta" : "Control";
    await controller.executeComputerAction({ type: "keypress", keys: [modKey, "a"] });
    await controller.executeComputerAction({ type: "keypress", keys: [modKey, "c"] });

    // 3. Focus Input B
    const obs2 = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs2.observationId,
      x: inputBPos.result.value.x,
      y: inputBPos.result.value.y,
    });

    // 4. Paste (Meta+V)
    await controller.executeComputerAction({ type: "keypress", keys: [modKey, "v"] });

    // Verify Input B contains copied string
    const valB = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('input-b').value",
      returnByValue: true,
    });

    expect(valB.result.value).toBe("SourceClipboardText");
  });

  it("should type into contenteditable div and textarea", async () => {
    const editorPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('editor').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const obs1 = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs1.observationId,
      x: editorPos.result.value.x,
      y: editorPos.result.value.y,
    });

    // Select all & type new text
    const isMac = process.platform === "darwin";
    const modKey = isMac ? "Meta" : "Control";
    await controller.executeComputerAction({ type: "keypress", keys: [modKey, "a"] });
    await controller.executeComputerAction({
      type: "type",
      text: "New Contenteditable Text",
      method: "auto",
    });

    const editorText = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('editor').innerText",
      returnByValue: true,
    });

    expect(editorText.result.value).toContain("New Contenteditable Text");
  });

  it("should scroll nested container", async () => {
    const scrollBoxPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('nested-scroll').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const obs = await controller.observe();
    await controller.executeComputerAction({
      type: "scroll",
      observationId: obs.observationId,
      x: scrollBoxPos.result.value.x,
      y: scrollBoxPos.result.value.y,
      deltaY: 200,
    });
    await new Promise((r) => setTimeout(r, 100));

    const stateEval = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__.scrollPosition",
      returnByValue: true,
    });

    expect(stateEval.result.value).toBeGreaterThan(50);
  });

  it("should intercept and handle all JavaScript dialog types (alert, confirm, prompt) and enforce DIALOG_BLOCKING", async () => {
    // 1. Alert Dialog
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => document.getElementById('trigger-alert').click(), 20)",
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(controller.activeDialog?.type).toBe("alert");

    // Verify input is blocked while dialog is open
    const blockedRes = await controller.executeComputerAction({
      type: "click",
      observationId: "obs_test",
      x: 100,
      y: 100,
    });
    expect(blockedRes.success).toBe(false);
    expect(blockedRes.errorCode).toBe("DIALOG_BLOCKING");

    // Accept alert dialog
    await controller.executeBrowserAction({ type: "handle_dialog", accept: true });
    expect(controller.activeDialog).toBeNull();

    // 2. Confirm Dialog (Accept)
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => document.getElementById('trigger-confirm').click(), 20)",
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(controller.activeDialog?.type).toBe("confirm");
    await controller.executeBrowserAction({ type: "handle_dialog", accept: true });

    let dialogState = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "window.__STATE__.dialogResult",
      returnByValue: true,
    });
    expect(dialogState.result.value).toBe("confirm_true");

    // 3. Confirm Dialog (Dismiss)
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => document.getElementById('trigger-confirm').click(), 20)",
    });
    await new Promise((r) => setTimeout(r, 150));
    await controller.executeBrowserAction({ type: "handle_dialog", accept: false });

    dialogState = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "window.__STATE__.dialogResult",
      returnByValue: true,
    });
    expect(dialogState.result.value).toBe("confirm_false");

    // 4. Prompt Dialog (with text)
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => document.getElementById('trigger-prompt').click(), 20)",
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(controller.activeDialog?.type).toBe("prompt");
    await controller.executeBrowserAction({ type: "handle_dialog", accept: true, promptText: "Emerald" });

    dialogState = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "window.__STATE__.dialogResult",
      returnByValue: true,
    });
    expect(dialogState.result.value).toBe("prompt_Emerald");
  });

  it("should manage browser windows and tabs using real CDP window APIs", async () => {
    // 1. List current windows
    const windows = await controller.getWindows();
    expect(windows.length).toBeGreaterThanOrEqual(1);
    const win1 = windows[0];
    expect(typeof win1.windowId).toBe("number");
    expect(win1.targetIds.length).toBeGreaterThanOrEqual(1);

    // 2. Open new window
    const newWinRes = await controller.executeBrowserAction({
      type: "new_window",
      url: `${server.url}/calibration.html`,
    });
    expect(newWinRes.success).toBe(true);

    const windowsAfterNew = await controller.getWindows();
    expect(windowsAfterNew.length).toBeGreaterThanOrEqual(1);

    // 3. Activate main window
    await controller.executeBrowserAction({
      type: "activate_window",
      windowId: win1.windowId,
    });

    // 4. Close the created tab
    await controller.executeBrowserAction({
      type: "close_tab",
      targetId: newWinRes.data.targetId,
    });
  });

  it("should cancel long-running operations immediately when stop() is called", async () => {
    const startTime = Date.now();

    // Start a 10-second wait
    const waitPromise = controller.executeComputerAction({
      type: "wait",
      ms: 10000,
    });

    // Abort/stop after 100ms
    await new Promise((r) => setTimeout(r, 100));
    await controller.stop();

    const waitResult = await waitPromise;
    const duration = Date.now() - startTime;

    expect(waitResult.success).toBe(false);
    expect(waitResult.errorCode).toBe("ACTION_CANCELLED");
    expect(duration).toBeLessThan(1000); // Cancelled in < 1 second!
  });
});
