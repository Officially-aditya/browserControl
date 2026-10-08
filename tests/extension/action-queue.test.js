import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = ts.createSourceFile(
  "service-worker.js",
  readFileSync(new URL("../../extension/service-worker.js", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
function functionSource(name) {
  const statement = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!statement) throw new Error(`Missing service-worker function: ${name}`);
  return statement.getText(source);
}

// Exercise the real extension queue with browser I/O and human delays stubbed.
function queueHarness(overrides = {}, realTyping = false) {
  const dependencies = {
    clickElement: vi.fn(async () => ({ success: true })),
    typeElement: vi.fn(async () => ({ success: true })),
    viewport: vi.fn(async () => ({ width: 1400, height: 800 })),
    send: vi.fn(async () => ({ result: { value: { tag: "input" } } })),
    sleep: vi.fn(async () => {}),
    randomBetween: () => 0,
    scrollChunks: (dx, dy) => [{ dx, dy }],
    scrollStepDelayMs: () => 0,
    setPointerFromViewport: vi.fn(),
    setPointerFromRecordPoint: vi.fn(),
    invalidateVisualState: vi.fn(),
    waitFor: vi.fn(async () => ({ success: true, reason: "idle" })),
    snapshot: vi.fn(async () => ({ observationId: "next", dom: "updated page" })),
    ensureAttached: vi.fn(async () => 1),
    humanTypeText: vi.fn(async () => {}),
    humanMouseMoveTo: vi.fn(async () => {}),
    dispatchClick: vi.fn(async () => {}),
    dispatchKeys: vi.fn(async () => {}),
    resolveElement: vi.fn(async () => ({ x: 100, y: 100, width: 50, height: 20 })),
    assertFresh: vi.fn(() => ({
      tabId: 1,
      sourceRegion: { x: 0, y: 0, width: 1400, height: 800 },
      viewportWidth: 1400,
      viewportHeight: 800,
    })),
    attachedTabId: 1,
    paused: false,
    FOCUS_ELEMENT_SCRIPT: "focus",
    visualEpoch: 1,
    controlContextEpoch: 1,
    ...overrides,
  };
  const run = new Function(
    ...Object.keys(dependencies),
    functionSource("normalizedPointToSource") +
      (realTyping ? functionSource("typeElement") : "") +
      functionSource("executeActionQueue") +
      "; return { run: executeActionQueue, changeContext: () => controlContextEpoch++, changeTab: (id) => attachedTabId = id };",
  )(...Object.values(dependencies));
  return { ...run, ...dependencies };
}

describe("extension action queue", () => {
  it("executes actions in order and returns the final snapshot", async () => {
    const order = [];
    const h = queueHarness({
      clickElement: vi.fn(async () => { order.push("click"); return { success: true }; }),
      typeElement: vi.fn(async () => { order.push("type"); return { success: true }; }),
    });
    const result = await h.run({
      queue: [
        { type: "click", target: { ref: 2 }, dwellMs: 0 },
        { type: "type", target: { selector: "#name" }, text: "Ada", dwellMs: 0 },
      ],
      waitForIdle: false,
    });
    expect(order).toEqual(["click", "type"]);
    expect(result).toMatchObject({ success: true, completedActions: 2, observationId: "next" });
    expect(h.snapshot).toHaveBeenCalledOnce();
  });

  it("resolves a queued typing target by its placeholder or label text", async () => {
    const h = queueHarness({}, true);
    await h.run({
      queue: [{ type: "type", target: { text: "Email" }, text: "ada@example.com" }],
      waitForIdle: false,
    });
    expect(h.send).toHaveBeenCalledWith("Runtime.evaluate", expect.objectContaining({
      expression: '(focus)(null, null, "Email")',
    }));
    expect(h.humanTypeText).toHaveBeenCalledWith("ada@example.com");
  });

  it("maps queued scroll positions from normalized coordinates and updates the pointer", async () => {
    const h = queueHarness();
    await h.run({
      queue: [{ type: "scroll", x: 0, y: 500, deltaY: 600 }],
      waitForIdle: false,
    });
    expect(h.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: 0, y: 400, deltaX: 0, deltaY: 600,
    });
    expect(h.setPointerFromRecordPoint).toHaveBeenCalledWith({ x: 0, y: 400 }, expect.objectContaining({ viewportWidth: 1400, viewportHeight: 800 }), "agent");
    expect(h.invalidateVisualState).toHaveBeenCalledWith("agent-scroll");
  });

  it("uses the observation crop for queued scrolling without fetching another viewport", async () => {
    const record = {
      tabId: 1,
      sourceRegion: { x: 700, y: 200, width: 400, height: 200 },
      viewportWidth: 1400,
      viewportHeight: 800,
    };
    const h = queueHarness({ assertFresh: vi.fn(() => record) });
    await h.run({
      observationId: "crop",
      queue: [{ type: "scroll", x: 500, y: 500, deltaY: 600 }],
      waitForIdle: false,
    });
    expect(h.assertFresh).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: 900, y: 300, deltaX: 0, deltaY: 600,
    });
    expect(h.setPointerFromRecordPoint).toHaveBeenCalledWith({ x: 900, y: 300 }, record, "agent");
    expect(h.viewport).not.toHaveBeenCalled();
  });

  it.each(["changeContext", "changeTab"])("stops later inputs when %s occurs in the same batch", async (change) => {
    const h = queueHarness();
    h.dispatchClick.mockImplementation(async () => h[change](2));
    const result = await h.run({
      observationId: "obs-1",
      queue: [
        { type: "click", x: 500, y: 250, dwellMs: 0 },
        { type: "keypress", keys: ["Tab"] },
        { type: "type", text: "must not type on another page" },
      ],
      waitForIdle: false,
    });
    expect(result).toMatchObject({ success: false, errorCode: "STALE_OBSERVATION", completedActions: 1, failedActionIndex: 1 });
    expect(h.dispatchKeys).not.toHaveBeenCalled();
    expect(h.humanTypeText).not.toHaveBeenCalled();
  });

  it("runs a planned click, type, Tab, type sequence with only a final snapshot", async () => {
    const h = queueHarness();
    const result = await h.run({
      observationId: "obs-1",
      queue: [
        { type: "click", x: 500, y: 250, dwellMs: 0 },
        { type: "type", text: "Ada", dwellMs: 0 },
        { type: "keypress", keys: ["Tab"], dwellMs: 0 },
        { type: "type", text: "ada@example.com", dwellMs: 0 },
      ],
      waitForIdle: false,
    });
    expect(result).toMatchObject({ success: true, completedActions: 4, observationId: "next" });
    expect(h.humanTypeText.mock.calls).toEqual([["Ada"], ["ada@example.com"]]);
    expect(h.dispatchKeys).toHaveBeenCalledWith(["Tab"]);
    expect(h.assertFresh).toHaveBeenCalledOnce();
    expect(h.viewport).not.toHaveBeenCalled();
    expect(h.snapshot).toHaveBeenCalledOnce();
  });

  it("honors an explicit zero-duration wait", async () => {
    const h = queueHarness();
    await h.run({ queue: [{ type: "wait", ms: 0 }], waitForIdle: false });
    expect(h.sleep.mock.calls[0]).toEqual([0]);
  });

  it("executes coordinate clicks and double-clicks with observation mapping", async () => {
    const h = queueHarness();
    const result = await h.run({
      observationId: "obs-1",
      queue: [
        { type: "click", x: 500, y: 250, dwellMs: 0 },
        { type: "double_click", x: 200, y: 100, button: "left", dwellMs: 0 },
      ],
      waitForIdle: false,
    });
    expect(result).toMatchObject({ success: true, completedActions: 2 });
    expect(h.assertFresh).toHaveBeenCalledWith("obs-1");
    expect(h.dispatchClick).toHaveBeenNthCalledWith(1, 700, 200, "left", 1);
    expect(h.dispatchClick).toHaveBeenNthCalledWith(2, 280, 80, "left", 2);
    expect(h.setPointerFromRecordPoint).toHaveBeenCalledTimes(2);
  });

  it("executes keypress shortcut actions", async () => {
    const h = queueHarness();
    const result = await h.run({
      queue: [{ type: "keypress", keys: ["Enter"], dwellMs: 0 }],
      waitForIdle: false,
    });
    expect(result).toMatchObject({ success: true, completedActions: 1 });
    expect(h.dispatchKeys).toHaveBeenCalledWith(["Enter"]);
    expect(h.invalidateVisualState).toHaveBeenCalledWith("agent-keypress");
  });

  it("types into the focused element when target is omitted", async () => {
    const h = queueHarness();
    const result = await h.run({
      queue: [{ type: "type", text: "direct text", dwellMs: 0 }],
      waitForIdle: false,
    });
    expect(result).toMatchObject({ success: true, completedActions: 1 });
    expect(h.humanTypeText).toHaveBeenCalledWith("direct text");
    expect(h.typeElement).not.toHaveBeenCalled();
    expect(h.invalidateVisualState).toHaveBeenCalledWith("agent-type");
  });

  it("rejects unsupported action types before executing any items", async () => {
    const h = queueHarness();
    await expect(h.run({
      queue: [{ type: "click", target: { ref: 1 } }, { type: "unknown_action" }],
    })).rejects.toThrow(/unsupported.*unknown_action/i);
    expect(h.clickElement).not.toHaveBeenCalled();
  });

  it("reports completed actions and stops at a failing item", async () => {
    const h = queueHarness({
      clickElement: vi.fn()
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new Error("Element not found")),
    });
    const result = await h.run({
      queue: [
        { type: "click", target: { ref: 1 }, dwellMs: 0 },
        { type: "click", target: { selector: "#missing" } },
        { type: "type", target: { ref: 3 }, text: "must not run" },
      ],
    });
    expect(result).toMatchObject({
      success: false, completedActions: 1, failedActionIndex: 1, message: "Element not found",
    });
    expect(h.clickElement).toHaveBeenCalledTimes(2);
    expect(h.typeElement).not.toHaveBeenCalled();
    expect(h.waitFor).not.toHaveBeenCalled();
  });

  it("reports a failed transition wait instead of claiming success", async () => {
    const h = queueHarness({
      waitFor: vi.fn(async () => ({ success: false, reason: "timeout" })),
    });
    const result = await h.run({
      queue: [{ type: "click", target: { text: "Next" } }],
      waitText: ["Next page"], timeoutMs: 500,
    });
    expect(result).toMatchObject({
      success: false, completedActions: 1, waitResult: { success: false, reason: "timeout" },
      observationId: "next",
    });
  });
});
