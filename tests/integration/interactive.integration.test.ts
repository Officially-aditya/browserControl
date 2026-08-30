import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { ChromeController } from "../../src/controller.js";

describe("Live Chrome Interactive Features, Keyboard, Dialogs & Tabs", () => {
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

  it("should handle mouse clicks (left, double, right) and hover dropdown", async () => {
    await controller.navigationController.navigate(`${server.url}/interactive.html`);
    await new Promise((r) => setTimeout(r, 150));

    // Find test-btn position
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
      x: btnPos.result.value.x,
      y: btnPos.result.value.y,
      button: "left",
    });

    // 2. Double click
    await controller.executeComputerAction({
      type: "double_click",
      x: btnPos.result.value.x,
      y: btnPos.result.value.y,
      button: "left",
    });

    // 3. Right click
    await controller.executeComputerAction({
      type: "click",
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

    await controller.executeComputerAction({
      type: "move",
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

    await controller.executeComputerAction({
      type: "click",
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

  it("should scroll nested container", async () => {
    const scrollBoxPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('nested-scroll').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    await controller.executeComputerAction({
      type: "scroll",
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

  it("should type into input and use keyboard shortcuts", async () => {
    const inputPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('text-input').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    // Focus input
    await controller.executeComputerAction({
      type: "click",
      x: inputPos.result.value.x,
      y: inputPos.result.value.y,
    });

    // Type text
    await controller.executeComputerAction({
      type: "type",
      text: "Testing Keyboard",
      method: "insert_text",
    });

    const stateEval = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('text-input').value",
      returnByValue: true,
    });

    expect(stateEval.result.value).toBe("Testing Keyboard");
  });

  it("should intercept and handle JavaScript dialogs", async () => {
    // Trigger an alert dialog asynchronously
    controller.session.send("Runtime.evaluate", {
      expression: "setTimeout(() => alert('Hello Automated Test!'), 20)",
    });

    // Wait for dialog to open
    await new Promise((r) => setTimeout(r, 150));

    const activeDialog = controller.activeDialog;
    expect(activeDialog).not.toBeNull();
    expect(activeDialog?.type).toBe("alert");
    expect(activeDialog?.message).toBe("Hello Automated Test!");

    // Accept dialog via browser action
    const handleRes = await controller.executeBrowserAction({
      type: "handle_dialog",
      accept: true,
    });
    expect(handleRes.success).toBe(true);

    expect(controller.activeDialog).toBeNull();
  });

  it("should open, switch, and close browser tabs", async () => {
    const initialTabs = await controller.getTabs();
    const countBefore = initialTabs.length;

    // Open new tab
    const newTabRes = await controller.executeBrowserAction({
      type: "new_tab",
      url: `${server.url}/calibration.html`,
    });
    expect(newTabRes.success).toBe(true);

    const tabsAfterNew = await controller.getTabs();
    expect(tabsAfterNew.length).toBe(countBefore + 1);

    // Close the created tab
    const closeRes = await controller.executeBrowserAction({
      type: "close_tab",
      targetId: newTabRes.data.targetId,
    });
    expect(closeRes.success).toBe(true);

    // Switch back to main tab
    await controller.tabController.switchTab(initialTabs[0].targetId);
    expect(controller.currentTargetId).toBe(initialTabs[0].targetId);
  });
});
