import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestServer, TestServer } from "../fixtures/test-server.js";
import { launchRealChrome, LaunchedChrome } from "../helpers/chrome-launcher.js";
import { ChromeController } from "../../src/controller.js";

describe("Live Chrome Granular Input Verification", () => {
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

  it("1. left click", async () => {
    const obs = await controller.observe();
    const btnPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('test-btn').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const res = await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: btnPos.result.value.x,
      y: btnPos.result.value.y,
      button: "left",
    });
    expect(res.success).toBe(true);

    const state = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__",
      returnByValue: true,
    });
    expect(state.result.value.clicks).toBe(1);
  });

  it("2. right click", async () => {
    const obs = await controller.observe();
    const btnPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('test-btn').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const res = await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: btnPos.result.value.x,
      y: btnPos.result.value.y,
      button: "right",
    });
    expect(res.success).toBe(true);

    const state = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__",
      returnByValue: true,
    });
    expect(state.result.value.rightClicks).toBe(1);
  });

  it("3. double click", async () => {
    const obs = await controller.observe();
    const btnPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('test-btn').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const res = await controller.executeComputerAction({
      type: "double_click",
      observationId: obs.observationId,
      x: btnPos.result.value.x,
      y: btnPos.result.value.y,
      button: "left",
    });
    expect(res.success).toBe(true);

    const state = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__",
      returnByValue: true,
    });
    expect(state.result.value.doubleClicks).toBe(1);
  });

  it("4. hover", async () => {
    const obs = await controller.observe();
    const menuBtnPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('hover-menu-btn').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const moveRes = await controller.executeComputerAction({
      type: "move",
      observationId: obs.observationId,
      x: menuBtnPos.result.value.x,
      y: menuBtnPos.result.value.y,
    });
    expect(moveRes.success).toBe(true);
    await new Promise((r) => setTimeout(r, 60));

    // Verify hover dropdown becomes visible and click child
    const item2Pos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('menu-item-2').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const obs2 = await controller.observe();
    const clickRes = await controller.executeComputerAction({
      type: "click",
      observationId: obs2.observationId,
      x: item2Pos.result.value.x,
      y: item2Pos.result.value.y,
    });
    expect(clickRes.success).toBe(true);

    const state = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__",
      returnByValue: true,
    });
    expect(state.result.value.hoverSelected).toBe("menu-item-2");
  });

  it("5. scroll", async () => {
    const obs = await controller.observe();
    const scrollBoxPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('nested-scroll').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const scrollRes = await controller.executeComputerAction({
      type: "scroll",
      observationId: obs.observationId,
      x: scrollBoxPos.result.value.x,
      y: scrollBoxPos.result.value.y,
      deltaY: 200,
    });
    expect(scrollRes.success).toBe(true);
    await new Promise((r) => setTimeout(r, 100));

    const state = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__.scrollPosition",
      returnByValue: true,
    });
    expect(state.result.value).toBeGreaterThan(50);
  });

  it("6. drag", async () => {
    const obs = await controller.observe();
    const sliderPos = await controller.session.send<{ result: { value: { left: number; top: number; width: number; height: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('drag-slider').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()",
        returnByValue: true,
      }
    );

    const startX = sliderPos.result.value.left + 5;
    const startY = sliderPos.result.value.top + sliderPos.result.value.height / 2;
    const endX = sliderPos.result.value.left + sliderPos.result.value.width * 0.8;
    const endY = startY;

    const dragRes = await controller.executeComputerAction({
      type: "drag",
      observationId: obs.observationId,
      path: [
        { x: startX, y: startY },
        { x: (startX + endX) / 2, y: startY },
        { x: endX, y: endY },
      ],
    });
    expect(dragRes.success).toBe(true);
    await new Promise((r) => setTimeout(r, 60));

    const state = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__.sliderValue",
      returnByValue: true,
    });
    expect(state.result.value).toBeGreaterThan(40);
  });

  it("7. held Shift + click", async () => {
    const item1Pos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('mod-item-1').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    // Hold Shift
    await controller.executeComputerAction({ type: "key_down", key: "Shift" });

    const obs = await controller.observe();
    const clickRes = await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: item1Pos.result.value.x,
      y: item1Pos.result.value.y,
    });
    expect(clickRes.success).toBe(true);

    const state = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__",
      returnByValue: true,
    });
    expect(state.result.value.lastClickShift).toBe(true);

    // Release Shift
    await controller.executeComputerAction({ type: "key_up", key: "Shift" });
  });

  it("8. held Meta/Control + click", async () => {
    const item2Pos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('mod-item-2').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const isMac = process.platform === "darwin";
    const modKey = isMac ? "Meta" : "Control";

    // Hold Meta/Control
    await controller.executeComputerAction({ type: "key_down", key: modKey });

    const obs = await controller.observe();
    const clickRes = await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: item2Pos.result.value.x,
      y: item2Pos.result.value.y,
    });
    expect(clickRes.success).toBe(true);

    const state = await controller.session.send<{ result: { value: any } }>("Runtime.evaluate", {
      expression: "window.__STATE__",
      returnByValue: true,
    });

    if (isMac) {
      expect(state.result.value.lastClickMeta).toBe(true);
    } else {
      expect(state.result.value.lastClickCtrl).toBe(true);
    }

    // Release Meta/Control
    await controller.executeComputerAction({ type: "key_up", key: modKey });
  });

  it("9. typing into input", async () => {
    const inputBPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('input-b').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const obs = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: inputBPos.result.value.x,
      y: inputBPos.result.value.y,
    });

    const typeRes = await controller.executeComputerAction({
      type: "type",
      text: "Hello Real Chrome",
      method: "auto",
    });
    expect(typeRes.success).toBe(true);

    const val = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('input-b').value",
      returnByValue: true,
    });
    expect(val.result.value).toBe("Hello Real Chrome");
  });

  it("10. textarea", async () => {
    const textareaPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('textarea-input').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const obs = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: textareaPos.result.value.x,
      y: textareaPos.result.value.y,
    });

    const typeRes = await controller.executeComputerAction({
      type: "type",
      text: "Multi-line\nTextarea Test",
      method: "auto",
    });
    expect(typeRes.success).toBe(true);

    const val = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('textarea-input').value",
      returnByValue: true,
    });
    expect(val.result.value).toContain("Multi-line\nTextarea Test");
  });

  it("11. contenteditable", async () => {
    const editorPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('editor').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    const obs = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: editorPos.result.value.x,
      y: editorPos.result.value.y,
    });

    const isMac = process.platform === "darwin";
    const modKey = isMac ? "Meta" : "Control";

    // Select all and replace text
    await controller.executeComputerAction({ type: "keypress", keys: [modKey, "a"] });
    const typeRes = await controller.executeComputerAction({
      type: "type",
      text: "Contenteditable Editor Value",
      method: "auto",
    });
    expect(typeRes.success).toBe(true);

    const editorText = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('editor').innerText",
      returnByValue: true,
    });
    expect(editorText.result.value).toContain("Contenteditable Editor Value");
  });

  it("12. keyboard shortcut", async () => {
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

    // 2. Meta/Control+A then Meta/Control+C
    const isMac = process.platform === "darwin";
    const modKey = isMac ? "Meta" : "Control";
    const selectAllRes = await controller.executeComputerAction({ type: "keypress", keys: [modKey, "a"] });
    expect(selectAllRes.success).toBe(true);

    const copyRes = await controller.executeComputerAction({ type: "keypress", keys: [modKey, "c"] });
    expect(copyRes.success).toBe(true);

    // 3. Focus Input B
    const obs2 = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs2.observationId,
      x: inputBPos.result.value.x,
      y: inputBPos.result.value.y,
    });

    // 4. Paste Meta/Control+V
    const pasteRes = await controller.executeComputerAction({ type: "keypress", keys: [modKey, "v"] });
    expect(pasteRes.success).toBe(true);

    const valB = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('input-b').value",
      returnByValue: true,
    });
    expect(valB.result.value).toBe("SourceClipboardText");
  });

  it("13. unicode, international script, and emoji typing", async () => {
    const inputBPos = await controller.session.send<{ result: { value: { x: number; y: number } } }>(
      "Runtime.evaluate",
      {
        expression: "(() => { const r = document.getElementById('input-b').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()",
        returnByValue: true,
      }
    );

    // Clear input B
    await controller.session.send("Runtime.evaluate", {
      expression: "document.getElementById('input-b').value = ''",
    });

    const obs = await controller.observe();
    await controller.executeComputerAction({
      type: "click",
      observationId: obs.observationId,
      x: inputBPos.result.value.x,
      y: inputBPos.result.value.y,
    });

    const unicodeString = "🚀 AI Agent: 你好, مرحبا, café, €50 🎉";
    const typeRes = await controller.executeComputerAction({
      type: "type",
      text: unicodeString,
      method: "auto",
    });
    expect(typeRes.success).toBe(true);

    const val = await controller.session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "document.getElementById('input-b').value",
      returnByValue: true,
    });
    expect(val.result.value).toBe(unicodeString);
  });
});

