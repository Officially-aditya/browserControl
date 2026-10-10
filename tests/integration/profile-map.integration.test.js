import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchRealChrome } from '../helpers/chrome-launcher.js';
import { ChromeController } from '../../src/controller.js';
import { keyDefinition, keyEvents } from '../../extension/keyboard.js';
import { humanClickPoint } from '../../extension/human-input.js';
import { normalizeProfileMap, parseProfileDate, readProfileControls, profileTarget, fillProfileFields } from '../../extension/profile-map.js';

const source = ts.createSourceFile('service-worker.js',
  readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function functionSource(name) {
  return source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}
const indexDeclaration = source.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(source) === 'ELEMENT_INDEX_HELPERS');
const ELEMENT_INDEX_HELPERS = new Function('return ' + indexDeclaration.initializer.getText(source))();

// Run the real extension filler and input dispatch functions over CDP in an isolated browser.
describe.skipIf(process.env.TEST_PROFILE_CHROME !== '1')('profile map filling in real Chrome', () => {
  let chrome, controller;
  beforeAll(async () => {
    chrome = await launchRealChrome();
    controller = new ChromeController({ mode: 'ws-endpoint', wsEndpoint: chrome.wsUrl });
    await controller.connect();
  }, 30000);
  afterAll(async () => {
    await controller?.disconnect();
    await chrome?.close();
  });

  function harness() {
    const deps = {
      normalizeProfileMap, parseProfileDate, readProfileControls, profileTarget, fillProfileFields,
      ELEMENT_INDEX_HELPERS, profileMaps: new Map(), keyDefinition, keyEvents,
      send: vi.fn((method, params) => controller.session.send(method, params)),
      ensureAttached: async () => 1, attachedTabId: 1, controlContextEpoch: 1, visualEpoch: 1, paused: false,
      sleep: async () => {}, keyHoldMs: () => 0, charFlightMs: () => 0, wordPauseMs: () => 0, shortcutHoldMs: () => 0,
      humanMouseMoveTo: async () => {}, preClickDelayMs: () => 0, clickHoldMs: () => 0,
      clickJitter: () => ({ dx: 0, dy: 0 }), humanClickPoint, RANDOMIZED_CLICK_POINT_SCRIPT: '() => null',
      viewport: async () => ({ width: 1280, height: 800 }), setPointerFromViewport: vi.fn(),
      invalidateVisualState: vi.fn(), snapshot: async () => ({ observationId: 'fresh', dom: 'snapshot' }),
    };
    return new Function(...Object.keys(deps),
      ['humanTypeText', 'dispatchKeys', 'dispatchClick', 'setProfile', 'fillProfile'].map(functionSource).join('\n')
      + '; return { set: setProfile, fill: fillProfile, pause: () => paused = true };')(...Object.values(deps));
  }
  async function page(html, setup = '') {
    await controller.session.send('Runtime.evaluate', { expression: 'document.body.innerHTML = ' + JSON.stringify(html) });
    if (setup) await controller.session.send('Runtime.evaluate', { expression: setup });
  }
  async function value(expression) {
    const response = await controller.session.send('Runtime.evaluate', { expression, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }

  it('fills a mixed DOB group after day replacement, education dropdowns, radios, checkboxes and dependent locations', async () => {
    await page(
      '<form onsubmit="return false">' +
      '<fieldset><legend>Date of birth</legend><label>Day<input id="day" placeholder="DD" maxlength="2"></label>' +
      '<label>Month<select id="month"><option disabled selected>Month</option><option value="2">March</option><option value="3">April</option><option value="4">May</option></select></label>' +
      '<label>Year<select id="year"><option disabled selected>Year</option><option>1997</option><option>1998</option><option>1999</option></select></label></fieldset>' +
      '<label>Education<select id="education"><option selected>Choose</option><option value="opaque">Completed university degree</option></select></label>' +
      '<fieldset><legend>Primary earner</legend><label><input id="no" name="earner" type="radio" value="1">No</label>' +
      '<label><input id="yes" name="earner" type="radio" value="0" style="display:none">Yes</label></fieldset>' +
      '<fieldset><legend>Languages</legend><label><input id="english" name="languages" type="checkbox">English</label>' +
      '<label><input id="hindi" name="languages" type="checkbox">Hindi</label><label><input id="marathi" name="languages" type="checkbox" checked>Marathi</label></fieldset>' +
      '<label>City<select id="city"><option>Choose</option></select></label>' +
      '<label>State<select id="state"><option>Choose</option></select></label>' +
      '<label>Country<select id="country"><option>Choose</option><option value="in">India</option></select></label>' +
      '<label>Pincode<input id="pin"></label><label>Favourite color<input id="color" value="Unchanged"></label>' +
      '<button id="submit">Submit</button></form>',
      'window.profileEvents = []; window.submissions = 0;' +
      'document.querySelector("form").onsubmit = e => { submissions++; e.preventDefault(); };' +
      'for (const type of ["input","change","click","keydown"]) document.addEventListener(type, e => { if (e.isTrusted) profileEvents.push([type,e.target.id]); });' +
      'document.querySelector("#month").onchange = () => { document.querySelector("#day").outerHTML = "<input id=day placeholder=DD maxlength=2>"; };' +
      'document.querySelector("#country").onchange = () => { document.querySelector("#state").innerHTML = "<option>Choose</option><option>Maharashtra</option>"; };' +
      'document.querySelector("#state").onchange = () => { document.querySelector("#city").innerHTML = "<option>Choose</option><option>Pune</option>"; };',
    );
    const h = harness();
    h.set({ values: { date_of_birth: '1998-04-12', highest_education: "Bachelor's degree", is_primary_earner: true,
      languages: ['English', 'Hindi'], country: 'India', state: 'Maharashtra', city: 'Pune', pincode: '001234' },
    optionAliases: { highest_education: { 'Completed university degree': "Bachelor's degree" } } }, 'local');
    const result = await h.fill({}, 'local');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.remaining).toEqual([expect.objectContaining({ question: 'Favourite color', reason: 'map_miss' })]);
    expect(await value('[day.value,month.value,year.value,education.value,yes.checked,english.checked,hindi.checked,marathi.checked,country.value,state.value,city.value,pin.value,color.value,submissions]'))
      .toEqual(['12', '3', '1998', 'opaque', true, true, true, false, 'in', 'Maharashtra', 'Pune', '001234', 'Unchanged', 0]);
    expect(await value('profileEvents.some(e => e[0] === "keydown") && profileEvents.some(e => e[0] === "input") && profileEvents.some(e => e[0] === "click")')).toBe(true);
    const again = await h.fill({}, 'local');
    expect(again.filled).toEqual([]);
    expect(again.alreadyFilled.length).toBeGreaterThan(8);
  });

  it('enters native and explicitly formatted text dates through real keyboard events', async () => {
    const h = harness();
    h.set({ values: { date_of_birth: '1998-04-12' } }, 'local');
    for (const [html, expected] of [
      ['<label>DOB<input id="dob" type="date" value="2000-01-01"></label>', '1998-04-12'],
      ['<label>DOB<input id="dob" placeholder="DD/MM/YYYY"></label>', '12/04/1998'],
      ['<label>DOB<input id="dob" placeholder="MM/DD/YYYY"></label>', '04/12/1998'],
    ]) {
      await page(html);
      const result = await h.fill({}, 'local');
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(await value('dob.value')).toBe(expected);
      expect(result.filled).toHaveLength(1);
    }
  });

  it('opens a live ARIA dropdown and selects its option without agent-specified interactions', async () => {
    await page('<button id="city" role="combobox" aria-label="City" aria-controls="cities" aria-expanded="false">Choose city</button>' +
      '<div id="cities" role="listbox" hidden><div id="pune" role="option" data-value="opaque">Pune</div><div role="option">Mumbai</div></div>',
      'city.onclick = () => { cities.hidden = false; city.setAttribute("aria-expanded","true"); };' +
      'pune.onclick = () => { city.textContent = "Pune"; city.setAttribute("aria-expanded","false"); cities.hidden = true; };');
    const h = harness();
    h.set({ values: { city: 'Pune' } }, 'local');
    const result = await h.fill({}, 'local');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.filled).toEqual([expect.objectContaining({ key: 'city', control: 'combobox' })]);
    expect(await value('[city.textContent, city.getAttribute("aria-expanded")]')).toEqual(['Pune', 'false']);
  });

  it('isolates transport/session maps, replaces and clears them, and honors pause', async () => {
    await page('<label>Pincode<input id="pin"></label>');
    const h = harness();
    h.set({ values: { pincode: '001234' }, profileSession: 'a' }, 'local');
    h.set({ values: { pincode: '777777' }, profileSession: 'a' }, 'remote');
    h.set({ values: { pincode: '555555' }, profileSession: 'b' }, 'local');
    await h.fill({ profileSession: 'a' }, 'local');
    expect(await value('pin.value')).toBe('001234');
    await h.fill({ profileSession: 'a' }, 'remote');
    expect(await value('pin.value')).toBe('777777');
    h.set({ values: {}, profileSession: 'a' }, 'local');
    await expect(h.fill({ profileSession: 'a' }, 'local')).rejects.toMatchObject({ code: 'PROFILE_NOT_SET' });
    h.pause();
    expect(await h.fill({ profileSession: 'b' }, 'local')).toMatchObject({ success: false, errorCode: 'CONTROL_PAUSED' });
    expect(await value('pin.value')).toBe('777777');
  });
});
