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
    invalidateVisualState: vi.fn(),
    waitFor: vi.fn(async () => ({ success: true, reason: "idle" })),
    snapshot: vi.fn(async () => ({ observationId: "next", dom: "updated page" })),
    ensureAttached: vi.fn(async () => 1),
    humanTypeText: vi.fn(async () => {}),
    FOCUS_ELEMENT_SCRIPT: "focus",
    visualEpoch: 1,
    ...overrides,
  };
  const run = new Function(
    ...Object.keys(dependencies),
    functionSource("normalizedPointToSource") +
      (realTyping ? functionSource("typeElement") : "") +
      functionSource("executeActionQueue") +
      "; return executeActionQueue;",
  )(...Object.values(dependencies));
  return { run, ...dependencies };
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
    expect(h.setPointerFromViewport).toHaveBeenCalledWith(0, 400, 1400, 800, "agent");
    expect(h.invalidateVisualState).toHaveBeenCalledWith("agent-scroll");
  });

  it("honors an explicit zero-duration wait", async () => {
    const h = queueHarness();
    await h.run({ queue: [{ type: "wait", ms: 0 }], waitForIdle: false });
    expect(h.sleep.mock.calls[0]).toEqual([0]);
  });

  it("rejects unsupported action types before executing any items", async () => {
    const h = queueHarness();
    await expect(h.run({
      queue: [{ type: "click", target: { ref: 1 } }, { type: "keypress", keys: ["Enter"] }],
    })).rejects.toThrow(/unsupported.*keypress/i);
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
