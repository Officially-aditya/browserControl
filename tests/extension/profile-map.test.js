import { describe, expect, it, vi } from 'vitest';
import { normalizeProfileMap, planProfileFields, fillProfileFields } from '../../extension/profile-map.js';

let nextToken = 0;
function field(names, extra = {}) {
  return { token: 'f' + ++nextToken, ref: nextToken, tag: 'input', type: 'text', role: '',
    names: [names], group: '', groupId: '', choiceGroup: '', value: '', text: '', checked: false,
    expanded: false, combo: false, options: [], disabled: false, readOnly: false, multiple: false,
    placeholder: '', maxLength: -1, min: '', max: '', formatHint: '', valid: true, ...extra };
}
function options(labels) {
  return labels.map((label, index) => ({ index, label, value: 'opaque-' + index, selected: index === 0, disabled: false }));
}
const profile = values => normalizeProfileMap({ values });
const dob = profile({ date_of_birth: '1998-04-12' });
function splitDate(mode) {
  return ['Day', 'Month', 'Year'].map((name, index) => field(name, {
    group: 'Date of birth', groupId: 'dob',
    ...(mode === 'dropdowns' || (mode === 'mixed' && index !== 0) ? {
      tag: 'select', type: 'select-one',
      options: options(index === 0 ? ['Day', '12'] : index === 1 ? ['Month', 'March', 'April'] : ['Year', '1998']),
    } : {}),
  }));
}

describe('profile map matching', () => {
  it('preserves leading zeroes and rejects invalid dates, facts, and alias references', () => {
    expect(profile({ pincode: '001234' }).values.pincode).toBe('001234');
    for (const values of [{ date_of_birth: '2001-02-29' }, { age: Infinity }, { city: {} }, { city: 'Pune\nSubmit' }]) {
      expect(() => profile(values)).toThrow();
    }
    expect(() => normalizeProfileMap({ values: { city: 'Pune' }, aliases: { 'City?': 'missing' } })).toThrow();
  });

  it.each(['inputs', 'dropdowns', 'mixed'])('plans %s DOB controls together in year/month/day order', mode => {
    const plans = planProfileFields(dob, splitDate(mode));
    expect(plans.map(p => p.component)).toEqual(['year', 'month', 'day']);
    expect(plans.map(p => p.answer)).toEqual([1998, 4, 12]);
    expect(plans.every(p => p.state === 'pending')).toBe(true);
    if (mode !== 'inputs') expect(plans[1].option).toMatchObject({ label: 'April', value: 'opaque-2' });
  });

  it.each(['April', 'Apr', '04', '4'])('matches month label %s independently of a zero-based submitted value', label => {
    const fields = splitDate('mixed');
    fields[1].options = [{ index: 0, label: 'March', value: '2' }, { index: 1, label, value: '3' }];
    expect(planProfileFields(dob, fields).find(p => p.component === 'month').option.value).toBe('3');
  });

  it('leaves ambiguous month encodings and incomplete date groups alone', () => {
    const fields = splitDate('mixed');
    fields[1].options = [{ index: 0, label: 'Unknown', value: '4' }];
    expect(planProfileFields(dob, fields).find(p => p.component === 'month').reason).toBe('no_unique_option');
    expect(planProfileFields(dob, fields.slice(0, 2)).every(p => p.reason === 'incomplete_date_group')).toBe(true);
  });

  it.each([['DD/MM/YYYY', '12/04/1998'], ['MM/DD/YYYY', '04/12/1998'], ['YYYY-MM-DD', '1998-04-12']])(
    'formats a text DOB using %s', (placeholder, answer) => {
      expect(planProfileFields(dob, [field('DOB', { placeholder })])[0]).toMatchObject({ answer, kind: 'type' });
    },
  );

  it('derives an explicitly labeled standalone birth year without requiring other date fields', () => {
    expect(planProfileFields(dob, [field('Birth year', { type: 'number' })])[0]).toMatchObject({ answer: 1998, state: 'pending' });
  });

  it('uses ISO for native dates and refuses an unspecified text-date format', () => {
    expect(planProfileFields(dob, [field('DOB', { type: 'date' })])[0]).toMatchObject({ answer: '1998-04-12', kind: 'date' });
    expect(planProfileFields(dob, [field('DOB')])[0].reason).toBe('unknown_date_format');
  });

  it('derives age at the birthday boundary and finds one bracket in a radio group', () => {
    const age = field('Age', { type: 'number' });
    expect(planProfileFields(dob, [age], new Date(2026, 3, 11))[0].answer).toBe(27);
    expect(planProfileFields(dob, [age], new Date(2026, 3, 12))[0].answer).toBe(28);
    const choices = ['18–24', '25 to 34', '35+'].map(label => field(label, {
      type: 'radio', group: 'How old are you?', choiceGroup: 'age',
    }));
    expect(planProfileFields(dob, choices, new Date(2026, 3, 12)).filter(p => p.state === 'pending')[0].control.names).toEqual(['25 to 34']);
    choices.push(field('20-30', { type: 'radio', group: 'How old are you?', choiceGroup: 'age' }));
    expect(planProfileFields(dob, choices, new Date(2026, 3, 12)).every(p => p.reason === 'no_unique_option')).toBe(true);
  });

  it('does not confuse yes/no labels with numeric radio values', () => {
    const choices = ['No', 'Yes'].map((label, index) => field(label, {
      type: 'radio', value: String(1 - index), group: 'Primary earner', choiceGroup: 'earner',
    }));
    const plans = planProfileFields(profile({ is_primary_earner: true }), choices);
    expect(plans.filter(p => p.state === 'pending')[0].control.names).toEqual(['Yes']);
  });

  it('uses only supplied education equivalences for dropdowns and radios', () => {
    const control = field('Education', { tag: 'select', options: options(['Select', 'Completed university degree']) });
    const values = { highest_education: "Bachelor's degree" };
    expect(planProfileFields(profile(values), [control])[0].reason).toBe('no_unique_option');
    const map = normalizeProfileMap({ values, optionAliases: { highest_education: { 'Completed university degree': "Bachelor's degree" } } });
    expect(planProfileFields(map, [control])[0].option.label).toBe('Completed university degree');
    const choice = field('Completed university degree', { type: 'radio', group: 'Education', choiceGroup: 'education' });
    expect(planProfileFields(map, [choice])[0].state).toBe('pending');
  });

  it('sets the full checkbox selection and refuses a group when a requested option is missing', () => {
    const choices = ['English', 'Hindi', 'Marathi'].map(label => field(label, {
      type: 'checkbox', group: 'Languages', choiceGroup: 'languages', checked: label === 'Marathi',
    }));
    expect(planProfileFields(profile({ languages: ['English', 'Hindi'] }), choices).map(p => p.answer)).toEqual([true, true, false]);
    expect(planProfileFields(profile({ languages: ['English', 'French'] }), choices).every(p => p.reason === 'no_unique_option')).toBe(true);
  });

  it('keeps similar questions and other people separate, while accepting contextual aliases', () => {
    const other = field('Date of birth', { type: 'date', group: 'Spouse details' });
    const controls = [other, field('Household income'), field('Pincode', { disabled: true })];
    expect(planProfileFields(profile({ date_of_birth: '1998-04-12', personal_income: 50000, pincode: '001234' }), controls).map(p => p.reason))
      .toEqual(expect.arrayContaining(['map_miss', 'control_unavailable']));
    const map = normalizeProfileMap({ values: { spouse_dob: '1995-06-03' }, aliases: { 'Spouse details Date of birth': 'spouse_dob' } });
    expect(planProfileFields(map, [other])[0]).toMatchObject({ answer: '1995-06-03', kind: 'date' });
  });

  it('leaves indistinguishable repeated controls for the agent', () => {
    expect(planProfileFields(profile({ city: 'Pune' }), [field('City'), field('City')]).every(p => p.reason === 'ambiguous_control')).toBe(true);
  });

  it('normalizes question punctuation without accepting substring hits or conflicting aliases', () => {
    const map = normalizeProfileMap({ values: { city: 'Pune', state: 'Maharashtra' },
      aliases: { 'Where do you live?': 'city', 'WHERE DO YOU LIVE': 'state' } });
    expect(planProfileFields(map, [field('Where do you live?')])[0].reason).toBe('ambiguous_question');
    expect(planProfileFields(profile({ city: 'Pune' }), [field('City of birth')])[0].reason).toBe('map_miss');
  });
});

describe('profile filling with refreshed controls', () => {
  function ioFor(controls, onAct) {
    return {
      read: vi.fn(async () => controls), sleep: vi.fn(async () => {}), escape: vi.fn(async () => {}),
      act: vi.fn(async plan => {
        const c = controls.find(c => c.token === plan.control.token);
        if (onAct) return onAct(plan, c);
        if (plan.kind === 'type') c.value = String(plan.answer);
        else if (plan.kind === 'click') c.checked = plan.answer;
        else if (plan.kind === 'select') c.options.forEach(o => o.selected = o.index === plan.option.index);
      }),
    };
  }

  it('refreshes dependent state/city fields and retains unmatched questions for the agent', async () => {
    const controls = [field('City', { tag: 'select' }), field('State', { tag: 'select' }), field('Country', {
      tag: 'select', options: options(['Choose', 'India']),
    }), field('Pincode'), field('Favourite color')];
    const io = ioFor(controls, (plan, c) => {
      if (plan.kind === 'type') c.value = String(plan.answer);
      else c.options.forEach(o => o.selected = o.index === plan.option.index);
      if (plan.key === 'country') controls[1].options = options(['Choose', 'Maharashtra']);
      if (plan.key === 'state') controls[0].options = options(['Choose', 'Pune']);
    });
    const result = await fillProfileFields(profile({ country: 'India', state: 'Maharashtra', city: 'Pune', pincode: '001234' }), io);
    expect(io.act.mock.calls.map(([p]) => p.key)).toEqual(['country', 'state', 'city', 'pincode']);
    expect(result.filled).toHaveLength(4);
    expect(result.remaining).toEqual([expect.objectContaining({ question: 'Favourite color', reason: 'map_miss' })]);
    const again = await fillProfileFields(profile({ country: 'India', state: 'Maharashtra', city: 'Pune', pincode: '001234' }), io);
    expect(again.alreadyFilled).toHaveLength(4);
    expect(io.act).toHaveBeenCalledTimes(4);
  });

  it('waits for delayed dependent city options before filling', async () => {
    const controls = [field('State', { tag: 'select', options: options(['Choose', 'Maharashtra']) }), field('City', { tag: 'select' })];
    const io = ioFor(controls);
    let reads = 0;
    io.read.mockImplementation(async () => {
      if (++reads === 5) controls[1].options = options(['Choose', 'Pune']);
      return controls;
    });
    const result = await fillProfileFields(profile({ state: 'Maharashtra', city: 'Pune' }), io);
    expect(result.filled).toHaveLength(2);
    expect(result.remaining).toEqual([]);
  });

  it('opens an ARIA dropdown, discovers its options, and verifies the committed answer', async () => {
    const combo = field('City', { tag: 'button', type: '', role: 'combobox', combo: true });
    const io = ioFor([combo], (plan, c) => {
      if (plan.kind === 'open') { c.expanded = true; c.options = [{ token: 'pune', label: 'Pune' }]; }
      if (plan.kind === 'option') { c.expanded = false; c.value = 'opaque-id'; c.text = 'Pune'; c.options = []; }
    });
    const result = await fillProfileFields(profile({ city: 'Pune' }), io);
    expect(io.act.mock.calls.map(([p]) => p.kind)).toEqual(['open', 'option']);
    expect(result.filled).toHaveLength(1);
  });

  it('searches lazy comboboxes and restores the original query on an option miss', async () => {
    const combo = field('City', { role: 'combobox', combo: true, value: 'Original' });
    const io = ioFor([combo], (plan, c) => {
      if (plan.kind === 'open') c.expanded = true;
      if (plan.kind === 'type') c.value = String(plan.answer);
    });
    const result = await fillProfileFields(profile({ city: 'Pune' }), io);
    expect(io.act.mock.calls.map(([p]) => p.answer)).toEqual(['Pune', 'Pune', 'Original']);
    expect(combo.value).toBe('Original');
    expect(result.remaining[0].reason).toBe('no_unique_option');
    expect(io.escape).toHaveBeenCalledOnce();
  });

  it('reports verification failures and preserves partial success', async () => {
    const controls = [field('Pincode'), field('City')];
    const io = ioFor(controls, (plan, c) => { if (plan.key === 'pincode') c.value = plan.answer; });
    const result = await fillProfileFields(profile({ pincode: '001234', city: 'Pune' }), io);
    expect(result.success).toBe(false);
    expect(result.filled).toEqual([expect.objectContaining({ key: 'pincode' })]);
    expect(result.remaining).toEqual([expect.objectContaining({ key: 'city', reason: 'verification_failed' })]);
  });

  it('stops on context changes, retains verified progress, and obeys field limits', async () => {
    const controls = [field('Pincode'), field('Education')];
    const map = profile({ pincode: '001234', highest_education: 'Graduate' });
    const io = ioFor(controls);
    const limited = await fillProfileFields(map, io, { maxFields: 1 });
    expect(limited.filled).toHaveLength(1);
    expect(limited.remaining[0].reason).toBe('field_limit');
    io.act.mockImplementationOnce(async () => { throw Object.assign(new Error('Tab changed'), { code: 'STALE_OBSERVATION' }); });
    const result = await fillProfileFields(map, io);
    expect(result).toMatchObject({ success: false, errorCode: 'STALE_OBSERVATION' });
    expect(result.alreadyFilled).toHaveLength(1);
  });
});
