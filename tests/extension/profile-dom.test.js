import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { normalizeProfileMap, parseProfileDate, readProfileControls, profileTarget, fillProfileFields, planProfileFields } from '../../extension/profile-map.js';
import { keyDefinition, keyEvents } from '../../extension/keyboard.js';

const source = ts.createSourceFile('service-worker.js',
  readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function functionSource(name) {
  return source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}
function node(tagName, extra = {}) {
  return { tagName, isConnected: true, value: '', type: '', id: '', name: '', labels: [],
    getAttribute: () => null, matches: () => false, closest: () => null, querySelector: () => null,
    getRootNode: () => ({}), textContent: '', parentElement: null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }),
    scrollIntoView: vi.fn(), focus: vi.fn(), select: vi.fn(), ...extra };
}
function scan(nodes, ids = {}) {
  const pageGlobal = {};
  const document = { body: {}, getElementById: id => ids[id], querySelectorAll: () => [] };
  const read = new Function('globalThis', 'document', 'bcInteractiveElements', 'bcVisible',
    'return (' + readProfileControls.toString() + ')();');
  const controls = read(pageGlobal, document, () => nodes, el => !el.hidden);
  return { controls, pageGlobal, document };
}
describe('live profile DOM discovery', () => {
  it('reads fieldset context, accessibility labels, disabled optgroups and format hints', () => {
    const legend = node('LEGEND', { textContent: 'Date of birth' });
    const group = node('FIELDSET', { matches: () => true, querySelector: () => legend });
    const label = node('LABEL', { textContent: 'Month' });
    const month = node('SELECT', { parentElement: group, labels: [label], type: 'select-one', id: 'month',
      options: [{ label: 'March', value: '2', selected: false }, { label: 'April', value: '3', parentElement: { disabled: true } }] });
    const date = node('INPUT', { type: 'text', getAttribute: attr => ({ 'aria-labelledby': 'dob-label', 'aria-describedby': 'dob-hint' })[attr] || null });
    const { controls } = scan([month, date], {
      'dob-label': node('SPAN', { textContent: 'DOB' }), 'dob-hint': node('SPAN', { textContent: 'DD/MM/YYYY' }),
    });
    expect(controls[0]).toMatchObject({ names: ['Month', 'month'], group: 'Date of birth', ref: 1 });
    expect(controls[0].groupId).not.toBe('');
    expect(controls[0].options[1]).toMatchObject({ label: 'April', value: '3', disabled: true });
    expect(controls[1]).toMatchObject({ names: ['DOB'], formatHint: 'DD/MM/YYYY', ref: 2 });
  });

  it('retains hidden native choices behind their labels and separates forms with the same radio name', () => {
    const formA = node('FORM'), formB = node('FORM');
    const radio = node('INPUT', { type: 'radio', name: 'earner', form: formA, checked: true });
    const label = node('LABEL', { textContent: 'Yes', control: radio });
    radio.labels = [label];
    const other = node('INPUT', { type: 'radio', name: 'earner', form: formB, labels: [node('LABEL', { textContent: 'No' })] });
    const { controls, pageGlobal } = scan([label, other]);
    expect(controls[0]).toMatchObject({ tag: 'input', type: 'radio', checked: true, names: ['Yes', 'earner'], ref: 1 });
    expect(controls[0].choiceGroup).not.toBe(controls[1].choiceGroup);
    const target = new Function('globalThis', 'return (' + profileTarget.toString() + ')(' + JSON.stringify(controls[0].token) + ');')(pageGlobal);
    expect(target).toMatchObject({ x: 60, y: 35, width: 100, height: 30 });
    expect(label.scrollIntoView).toHaveBeenCalledOnce();
  });

  it('associates options only with the combobox controlled listbox', () => {
    const option = node('DIV', { textContent: 'Pune', getAttribute: attr => attr === 'data-value' ? 'opaque' : null });
    const root = node('DIV', { querySelectorAll: () => [option] });
    const combo = node('BUTTON', { getAttribute: attr => ({ role: 'combobox', 'aria-label': 'City', 'aria-controls': 'cities', 'aria-expanded': 'true' })[attr] || null });
    const { controls } = scan([combo], { cities: root });
    expect(controls[0]).toMatchObject({ combo: true, expanded: true, names: ['City'] });
    expect(controls[0].options).toEqual([expect.objectContaining({ label: 'Pune', value: 'opaque' })]);
  });

  it('preserves an outer spouse context around a nested DOB question', () => {
    const outer = node('FIELDSET', { matches: () => true, querySelector: () => node('LEGEND', { textContent: 'Spouse details' }) });
    const inner = node('FIELDSET', { parentElement: outer, matches: () => true, querySelector: () => node('LEGEND', { textContent: 'Date of birth' }) });
    const input = node('INPUT', { parentElement: inner, type: 'date', labels: [node('LABEL', { textContent: 'DOB' })] });
    const { controls } = scan([input]);
    expect(controls[0]).toMatchObject({ group: 'Date of birth', context: 'Spouse details' });
    const own = normalizeProfileMap({ values: { date_of_birth: '1998-04-12' } });
    expect(planProfileFields(own, controls)[0].reason).toBe('map_miss');
    const spouse = normalizeProfileMap({ values: { spouse_dob: '1995-06-03' }, aliases: { 'Spouse details Date of birth': 'spouse_dob' } });
    expect(planProfileFields(spouse, controls)[0]).toMatchObject({ answer: '1995-06-03', state: 'pending' });
  });

  it('refuses to focus a retained node after the page removes or disables it', () => {
    const el = node('INPUT', { type: 'text', id: 'pin' });
    const { controls, pageGlobal } = scan([el]);
    el.isConnected = false;
    const target = new Function('globalThis', 'token', 'return (' + profileTarget.toString() + ')(token, true);');
    expect(() => target(pageGlobal, controls[0].token)).toThrow('unavailable');
    expect(el.focus).not.toHaveBeenCalled();
  });
});

function control(extra = {}) {
  return { token: 'p1', ref: 1, tag: 'input', type: 'text', role: '', names: ['Pincode'], group: '', groupId: '',
    choiceGroup: '', value: '', text: '', checked: false, expanded: false, combo: false, options: [],
    disabled: false, readOnly: false, multiple: false, placeholder: '', maxLength: -1, min: '', max: '', valid: true, formatHint: '', ...extra };
}
function workerHarness(c, overrides = {}) {
  const deps = {
    normalizeProfileMap, parseProfileDate, readProfileControls, profileTarget, fillProfileFields, keyDefinition, keyEvents,
    profileMaps: new Map(), ELEMENT_INDEX_HELPERS: '',
    attachedTabId: 1, controlContextEpoch: 1, visualEpoch: 1, paused: false, ensureAttached: async () => 1,
    sleep: async () => {}, keyHoldMs: () => 0, charFlightMs: () => 0, wordPauseMs: () => 0, shortcutHoldMs: () => 0,
    dispatchKeys: vi.fn(async () => {}), viewport: async () => ({ width: 1000, height: 800 }),
    dispatchClick: vi.fn(async () => ({ x: 10, y: 10 })), setPointerFromViewport: vi.fn(), invalidateVisualState: vi.fn(),
    snapshot: vi.fn(async () => ({ observationId: 'fresh' })),
    send: vi.fn(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { value: params.expression.startsWith('(() =>')
        ? structuredClone([c]) : { x: 10, y: 10, width: 100, height: 30, dateOrder: ['month', 'day', 'year'] } } };
      if (method === 'Input.insertText') c.value += params.text;
      return {};
    }),
    ...overrides,
  };
  const run = new Function(...Object.keys(deps),
    functionSource('humanTypeText') + functionSource('setProfile') + functionSource('fillProfile')
    + '; return { set: setProfile, fill: fillProfile, pause: () => paused = true, navigate: () => controlContextEpoch++ };')(...Object.values(deps));
  return { ...run, ...deps };
}

describe('profile input dispatch', () => {
  it.each([['month', 'day', 'year'], ['day', 'month', 'year']])(
    'repositions native date segments when numeric typing automatically advances them (%j)', async (...order) => {
      const c = control({ type: 'date', names: ['DOB'], value: '2000-01-01' });
      const date = { year: '2000', month: '01', day: '01' };
      let cursor = 0, selected = true;
      const keys = vi.fn(async ([key]) => {
        if (key === 'ArrowLeft' || key === 'ArrowRight') { cursor = Math.max(0, Math.min(2, cursor + (key === 'ArrowLeft' ? -1 : 1))); selected = true; }
        if (/^\d$/.test(key)) {
          const part = order[cursor];
          date[part] = selected ? key : date[part] + key;
          selected = false;
          if (part !== 'year' && (date[part].length === 2 || Number(date[part]) > (part === 'month' ? 1 : 3))) {
            cursor = Math.min(2, cursor + 1); selected = true;
          }
        }
        c.value = date.year.padStart(4, '0') + '-' + date.month.padStart(2, '0') + '-' + date.day.padStart(2, '0');
      });
      const h = workerHarness(c, { dispatchKeys: keys });
      h.send.mockImplementation(async (_method, params) => ({ result: { value: params.expression.startsWith('(() =>')
        ? structuredClone([c]) : { dateOrder: order } } }));
      h.set({ values: { date_of_birth: '1998-04-12' } }, 'local');
      const result = await h.fill({}, 'local');
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(c.value).toBe('1998-04-12');
      expect(result.filled).toHaveLength(1);
    },
  );

  it('selects native dropdowns through the shortest enabled keyboard path', async () => {
    const c = control({ tag: 'select', type: 'select-one', names: ['City'],
      options: ['Choose', 'Mumbai', 'Pune', 'Delhi'].map((label, index) => ({ index, label, value: label, disabled: index === 1, selected: index === 0 })) });
    const keys = vi.fn(async ([key]) => {
      const enabled = c.options.filter(o => !o.disabled);
      const index = enabled.findIndex(o => o.selected);
      const next = key === 'Home' ? 0 : key === 'End' ? enabled.length - 1 : key === 'ArrowUp' ? index - 1 : key === 'ArrowDown' ? index + 1 : index;
      c.options.forEach(o => o.selected = o === enabled[next]);
    });
    const h = workerHarness(c, { dispatchKeys: keys });
    h.set({ values: { city: 'Pune' } }, 'local');
    expect((await h.fill({}, 'local')).filled).toHaveLength(1);
    expect(c.options.find(o => o.selected).label).toBe('Pune');
    expect(keys.mock.calls.map(([keys]) => keys)).toEqual([['Home'], ['ArrowDown'], ['Tab']]);
  });

  it('stops human typing at the next character when the user pauses', async () => {
    const c = control(), h = workerHarness(c);
    h.send.mockImplementation(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { value: params.expression.startsWith('(() =>') ? structuredClone([c]) : {} } };
      if (method === 'Input.insertText') { c.value += params.text; h.pause(); }
      return {};
    });
    h.set({ values: { pincode: '001234' } }, 'local');
    const result = await h.fill({}, 'local');
    expect(result).toMatchObject({ success: false, errorCode: 'CONTROL_PAUSED', filled: [] });
    expect(c.value).toBe('0');
    expect(h.snapshot).not.toHaveBeenCalled();
  });
});
