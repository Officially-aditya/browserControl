import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = ts.createSourceFile(
  "service-worker.js",
  readFileSync(new URL("../../extension/service-worker.js", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS,
);
function functionSource(name) {
  return source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}
function variableSource(name) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(node => node.name.getText(source) === name);
    if (declaration) return `const ${name} = ${declaration.initializer.getText(source)};`;
  }
  throw new Error(`Missing ${name}`);
}
const snapshotScript = new Function(
  variableSource("ELEMENT_INDEX_HELPERS") + variableSource("DOM_SNAPSHOT_SCRIPT") + "; return DOM_SNAPSHOT_SCRIPT;",
)();
const mapPoint = new Function(functionSource("normalizedPointToSource") + "; return normalizedPointToSource;")();

function element(id, options = {}) {
  const { left = 100, top = 100, width = 20, height = 20 } = options;
  return {
    nodeType: 1, tagName: "INPUT", id, type: "text", value: "", tabIndex: 0,
    children: [], childNodes: [],
    getAttribute: () => null,
    matches(selector) { return selector === ":disabled" && Boolean(this.disabled || this.fieldsetDisabled); },
    closest() { return this.inert ? this : null; },
    getRootNode: () => null,
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
    ...options,
  };
}
function page(elements, activeElement = null) {
  const body = element("body", { tagName: "BODY", tabIndex: -1, children: elements });
  const document = { body, activeElement: activeElement || body };
  for (const el of elements) el.getRootNode = () => document;
  return {
    document,
    getComputedStyle: el => ({ display: el.hidden ? "none" : "block", visibility: "visible" }),
  };
}
function domSnapshot(elements, width = 1265, height = 800, activeElement = null) {
  const context = page(elements, activeElement);
  return new Function("document", "getComputedStyle", `return (${snapshotScript})(${width}, ${height});`)(
    context.document, context.getComputedStyle,
  );
}

describe("extension snapshot planning", () => {
  it("round-trips snapshot coordinates using the same viewport dimensions as the observation", async () => {
    const context = page([element("near-right", { left: 1190, top: 190 })]);
    const rememberObservation = vi.fn();
    const dependencies = {
      ensureAttached: async () => 1,
      chrome: { tabs: { get: async () => ({ url: "https://example.com", title: "Form" }) } },
      viewport: vi.fn(async () => ({ width: 1265, height: 800, surfaceWidth: 1280, surfaceHeight: 800 })),
      send: vi.fn(async (_method, params) => ({ result: { value: new Function(
        "document", "getComputedStyle", `return ${params.expression};`,
      )(context.document, context.getComputedStyle) } })),
      DOM_SNAPSHOT_SCRIPT: snapshotScript,
      crypto: { randomUUID: () => "snapshot" }, visualEpoch: 1,
      rememberObservation, pointerMetadata: () => ({ known: false }),
    };
    const snapshot = new Function(...Object.keys(dependencies), functionSource("snapshot") + "; return snapshot;")(
      ...Object.values(dependencies),
    );
    const result = await snapshot();
    const record = rememberObservation.mock.calls[0][0];
    const [, x, y] = /id="near-right".*@\((\d+),(\d+)\)/.exec(result.dom);
    const point = mapPoint(Number(x), Number(y), record);
    expect(point.x).toBeCloseTo(1200, 0);
    expect(point.y).toBe(200);
    expect(result).toMatchObject({ viewportWidth: 1265, viewportHeight: 800, focusedRef: null, tabOrder: [1] });
    expect(record.sourceRegion).toEqual({ x: 0, y: 0, width: 1265, height: 800 });
    expect(dependencies.send).toHaveBeenCalledOnce();
  });

  it("marks offscreen elements without advertising misleading edge coordinates", () => {
    const result = domSnapshot([
      element("below", { top: 1800 }),
      element("above", { top: -100 }),
      element("right", { left: 1300 }),
    ]);
    expect(result.interactiveCount).toBe(3);
    for (const line of result.dom.split("\n")) {
      expect(line).toContain("[offscreen]");
      expect(line).not.toContain("@(");
    }
  });

  it("places coordinates inside the visible portion of a partially clipped element", () => {
    const result = domSnapshot([element("clipped", { left: 1250, top: 780, width: 100, height: 100 })]);
    const [, x, y] = /@\((\d+),(\d+)\)/.exec(result.dom);
    const point = mapPoint(Number(x), Number(y), { sourceRegion: { x: 0, y: 0, width: 1265, height: 800 } });
    expect(point.x).toBeGreaterThan(1250);
    expect(point.x).toBeLessThan(1265);
    expect(point.y).toBe(790.4);
  });

  it("reports focus and tab order independently of element refs", () => {
    const elements = [
      element("name"), element("email", { tabIndex: 2 }), element("first", { tabIndex: 1 }),
      element("disabled", { disabled: true }), element("programmatic", { tabIndex: -1 }),
      element("inert", { inert: true }), element("fieldset-disabled", { fieldsetDisabled: true }),
      element("hidden", { hidden: true }),
    ];
    const result = domSnapshot(elements, 1265, 800, elements[1]);
    expect(result.focusedRef).toBe(2);
    expect(result.tabOrder).toEqual([3, 2, 1]);
    expect(result.dom).toMatch(/id="email".*tabindex="2" focused/);
    expect(result.dom).not.toContain('id="hidden"');
  });

  it("includes one tab stop per radio group and keeps separate forms independent", () => {
    const form = {}, otherForm = {};
    const result = domSnapshot([
      element("radio-a", { type: "radio", name: "choice", form }),
      element("radio-b", { type: "radio", name: "choice", form, checked: true }),
      element("other-form", { type: "radio", name: "choice", form: otherForm }),
      element("first-unchecked", { type: "radio", name: "unchecked", form }),
      element("second-unchecked", { type: "radio", name: "unchecked", form }),
    ]);
    expect(result.tabOrder).toEqual([2, 3, 4]);
  });

  it("changes the queue context only for navigation, detach, or resize", () => {
    const harness = new Function(`
      let visualEpoch = 0, controlContextEpoch = 0, lastInvalidationReason, lastInvalidatedAt;
      const observations = new Map();
      ${functionSource("invalidateVisualState")}
      return { invalidateVisualState, context: () => controlContextEpoch };
    `)();
    for (const reason of ["agent-click", "agent-type", "agent-keypress", "agent-scroll"]) harness.invalidateVisualState(reason);
    expect(harness.context()).toBe(0);
    for (const reason of ["main-frame-navigated", "main-frame-same-document-navigation", "window-resized", "debugger-detached"]) harness.invalidateVisualState(reason);
    expect(harness.context()).toBe(4);
  });
});
