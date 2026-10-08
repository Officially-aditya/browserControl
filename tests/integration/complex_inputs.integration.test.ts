import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChromeController } from "../../src/controller.js";
import { launchRealChrome, type LaunchedChrome } from "../helpers/chrome-launcher.js";
import { keyEvents } from "../../extension/keyboard.js";

const source = ts.createSourceFile("service-worker.js",
  readFileSync(new URL("../../extension/service-worker.js", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const scriptNames = ["ELEMENT_INDEX_HELPERS", "DOM_SNAPSHOT_SCRIPT", "RESOLVE_ELEMENT_SCRIPT"];
const declarations = source.statements.filter(ts.isVariableStatement).flatMap(statement =>
  statement.declarationList.declarations.filter(declaration => scriptNames.includes(declaration.name.getText(source)))
    .map(declaration => `const ${declaration.name.getText(source)} = ${declaration.initializer!.getText(source)};`));
const scripts = new Function(declarations.join("\n") + "; return { DOM_SNAPSHOT_SCRIPT, RESOLVE_ELEMENT_SCRIPT };")();

const form = `
  <label for="country">Country</label>
  <select id="country">
    <option value="" disabled selected>Choose a country</option>
    <optgroup label="Available"><option value="in">India</option><option value="jp">Japan</option></optgroup>
    <optgroup label="Unavailable" disabled><option value="us">United States</option></optgroup>
  </select>
  <table>
    <thead><tr><th>Question</th><th scope="col">No</th><th scope="col">Yes</th></tr></thead>
    <tbody>
      <tr><th scope="row" id="service">Service</th><td><input id="service-no" type="radio" name="service"></td><td><input id="service-yes" type="radio" name="service"></td></tr>
      <tr><th scope="row">Price</th><td><input id="price-no" type="radio" name="price"></td><td><input id="price-yes" type="radio" name="price"></td></tr>
      <tr><th scope="row">Region</th><td colspan="2"><select id="region"><option>Asia</option><option>Europe</option></select></td></tr>
    </tbody>
  </table>
  <div role="grid">
    <div role="row"><span role="columnheader">Question</span><span role="columnheader">Bad</span><span role="columnheader">Good</span></div>
    <div role="row"><span role="rowheader">Quality</span><span role="gridcell"><button id="quality-bad" role="radio" aria-checked="false" aria-label="Bad">Bad</button></span><span role="gridcell"><button id="quality-good" role="radio" aria-checked="true" aria-label="Good">Good</button></span></div>
  </div>
  <h2 id="fruit-label">Choose a fruit</h2>
  <div role="radiogroup" aria-labelledby="fruit-label">
    <input id="apple" type="radio" name="fruit" style="display:none">
    <label id="apple-label" for="apple"><img alt="Apple" width="60" height="60">Apple</label>
    <input id="pear" type="radio" name="fruit" style="display:none">
    <label id="pear-label" for="pear"><img width="60" height="60"></label>
  </div>
  <button id="canvas-choice"><canvas width="40" height="40"></canvas></button>
  <button id="custom-select" role="combobox" aria-labelledby="fruit-label" aria-expanded="false" aria-controls="fruit-options">Choose</button>
  <div id="fruit-options" role="listbox" hidden><div id="banana" role="option" aria-selected="false">Banana</div></div>
  <fieldset><legend>Preferences</legend><input id="preference" type="checkbox"><label for="preference">Email updates</label></fieldset>
  <fieldset disabled><select id="disabled-select"><option>Disabled</option></select></fieldset>
`;

describe("extension snapshots for complex inputs in Chrome", () => {
  let chrome: LaunchedChrome;
  let controller: ChromeController;

  async function evaluate<T = any>(expression: string): Promise<T> {
    const result = await controller.session.send<any>("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  const snapshot = () => evaluate(`(${scripts.DOM_SNAPSHOT_SCRIPT})(innerWidth, innerHeight)`);
  const lineFor = (dom: string, id: string) => dom.split("\n").find((line: string) => line.includes(`id="${id}"`))!;

  async function clickRef(ref: number) {
    const rect = await evaluate(`(${scripts.RESOLVE_ELEMENT_SCRIPT})(null, ${ref}, null)`);
    expect(rect.width).toBeGreaterThan(0);
    await controller.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await controller.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  }

  beforeAll(async () => {
    chrome = await launchRealChrome();
    controller = new ChromeController({ mode: "ws-endpoint", wsEndpoint: chrome.wsUrl });
    await controller.connect();
  }, 20000);
  afterAll(async () => {
    await controller?.disconnect();
    await chrome?.close();
  });
  beforeEach(async () => {
    await evaluate(`document.body.innerHTML = ${JSON.stringify(form)}`);
  });

  it("lists native dropdown options and verifies a selection made with real keyboard input", async () => {
    const before = await snapshot();
    expect(lineFor(before.dom, "country")).toContain('label="Country"');
    expect(before.dom).toContain('option index=0 value="" label="Choose a country" selected disabled');
    expect(before.dom).toContain('option index=1 value="in" label="India" group="Available"');
    expect(before.dom).toContain('option index=3 value="us" label="United States" group="Unavailable" disabled');
    await evaluate("document.getElementById('country').focus()");
    for (const key of ["j", "Enter"]) {
      const events = keyEvents([key]);
      await controller.session.send("Input.dispatchKeyEvent", events.down);
      if (events.down.text) await controller.session.send("Input.dispatchKeyEvent", { type: "char", text: events.down.text });
      await controller.session.send("Input.dispatchKeyEvent", events.up);
    }
    const after = await snapshot();
    expect(after.dom).toContain('option index=2 value="jp" label="Japan" group="Available" selected');
  });

  it("identifies each matrix choice by row and column and selects its live ref", async () => {
    const before = await snapshot();
    expect(lineFor(before.dom, "service-no")).toContain('row="Service" column="No"');
    expect(lineFor(before.dom, "price-yes")).toContain('row="Price" column="Yes"');
    expect(lineFor(before.dom, "region")).toContain('row="Region" column="No"');
    expect(before.dom).toContain('label="Europe"');
    const ref = Number(/\[(\d+)\]/.exec(lineFor(before.dom, "service-yes"))![1]);
    await clickRef(ref);
    const after = await snapshot();
    expect(lineFor(after.dom, "service-yes")).toMatch(/\bchecked\b/);
    expect(lineFor(after.dom, "price-yes")).toMatch(/\bunchecked\b/);
  });

  it("exposes ARIA grid context, labels and selection state", async () => {
    const result = await snapshot();
    expect(lineFor(result.dom, "quality-good")).toContain('row="Quality" column="Good"');
    expect(lineFor(result.dom, "quality-good")).toContain('aria-checked="true"');
    expect(lineFor(result.dom, "preference")).toContain('label="Email updates" group="Preferences"');
    expect(lineFor(result.dom, "disabled-select")).toMatch(/\bdisabled\b/);
  });

  it("makes hidden image-input labels clickable and verifies their checked state", async () => {
    const before = await snapshot();
    const choice = lineFor(before.dom, "apple-label");
    expect(choice).toContain('group="Choose a fruit"');
    expect(choice).toContain("visual-choice");
    expect(before.dom).not.toContain('id="apple"');
    expect(before.dom).toMatch(/\[img alt="Apple"\] @\(\d+,\d+\)/);
    expect(before.dom).toMatch(/\[img visual-only\] @\(\d+,\d+\)/);
    expect(before.dom).toMatch(/\[canvas visual-only\] @\(\d+,\d+\)/);
    expect(lineFor(before.dom, "canvas-choice")).toContain("visual-choice");
    await clickRef(Number(/\[(\d+)\]/.exec(choice)![1]));
    expect(await evaluate("document.getElementById('apple').checked")).toBe(true);
    expect(lineFor((await snapshot()).dom, "apple-label")).toMatch(/\bchecked\b/);
  });

  it("reveals custom dropdown options and state changes in the next snapshot", async () => {
    const before = await snapshot();
    expect(lineFor(before.dom, "custom-select")).toContain('label="Choose a fruit"');
    expect(lineFor(before.dom, "custom-select")).toContain('aria-expanded="false"');
    expect(before.dom).not.toContain('id="banana"');
    await evaluate(`document.getElementById('custom-select').onclick = () => {
      document.getElementById('custom-select').setAttribute('aria-expanded', 'true');
      document.getElementById('fruit-options').hidden = false;
    }`);
    await clickRef(Number(/\[(\d+)\]/.exec(lineFor(before.dom, "custom-select"))![1]));
    const after = await snapshot();
    expect(lineFor(after.dom, "custom-select")).toContain('aria-expanded="true"');
    expect(lineFor(after.dom, "banana")).toContain('aria-selected="false"');
  });
});
