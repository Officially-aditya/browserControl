// Agent-supplied facts stay in the extension. Page scripts only read controls and focus targets.
export function profileText(value) {
  return String(value ?? '').normalize('NFKC').replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const DOB_KEYS = ['date of birth', 'dob', 'birth date'];
const COMMON_NAMES = {
  'date of birth': ['dob', 'birth date', 'birthdate', 'your date of birth', 'birth day', 'birth month', 'birth year'],
  age: ['your age', 'how old are you'],
  pincode: ['pin code', 'postal code', 'postcode', 'zip code'],
  'is primary earner': ['primary earner', 'are you the primary earner'],
  'highest education': ['education', 'highest completed education', 'highest level of education'],
};

function birthDate(values) {
  const key = Object.keys(values).find(key => DOB_KEYS.includes(profileText(key)));
  return key ? values[key] : undefined;
}

export function parseProfileDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(value + 'T12:00:00Z');
  return year >= 1000 && date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day ? { year, month, day } : null;
}

export function normalizeProfileMap(params = {}) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_PROFILE' }); };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const scalar = value => (typeof value === 'string' && value.length <= 500 && !/[\r\n\t]/.test(value))
    || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  if (!object(params.values) || Object.keys(params.values).length > 100) fail('values must be an object with at most 100 facts');
  const values = Object.create(null);
  for (const [key, value] of Object.entries(params.values)) {
    if (!profileText(key) || key.length > 200 || !(scalar(value)
      || (Array.isArray(value) && value.length <= 50 && value.every(scalar)))) fail('Invalid profile fact: ' + key);
    values[key] = Array.isArray(value) ? [...value] : value;
    if (DOB_KEYS.includes(profileText(key)) && !parseProfileDate(value)) fail('Date of birth must be a valid YYYY-MM-DD date');
  }
  const aliases = Object.create(null), optionAliases = Object.create(null);
  if (params.aliases !== undefined && !object(params.aliases)) fail('aliases must be a question-to-fact object');
  if (Object.keys(params.aliases || {}).length > 500) fail('Too many question aliases');
  for (const [question, key] of Object.entries(params.aliases || {})) {
    if (!profileText(question) || question.length > 500 || typeof key !== 'string'
      || (!Object.hasOwn(values, key) && !(key === 'age' && birthDate(values)))) fail('Unknown alias fact: ' + key);
    aliases[question] = key;
  }
  if (params.optionAliases !== undefined && !object(params.optionAliases)) fail('optionAliases must be an object');
  for (const [key, options] of Object.entries(params.optionAliases || {})) {
    if (!Object.hasOwn(values, key) || !object(options) || Object.keys(options).length > 100) fail('Invalid option aliases for ' + key);
    optionAliases[key] = Object.create(null);
    for (const [label, value] of Object.entries(options)) {
      if (!profileText(label) || label.length > 500 || !scalar(value)) fail('Invalid option alias for ' + key);
      optionAliases[key][label] = value;
    }
  }
  const profile = { values, aliases, optionAliases };
  if (JSON.stringify(profile).length > 65536) fail('Profile map is too large');
  return profile;
}

// Injected with ELEMENT_INDEX_HELPERS so profile discovery and snapshot refs agree.
export function readProfileControls() {
  const registry = globalThis.__browserControlProfileNodes ||= { ids: new WeakMap(), nodes: new Map(), next: 0 };
  for (const [id, node] of registry.nodes) if (!node.isConnected) registry.nodes.delete(id);
  const token = node => {
    if (!node) return '';
    if (!registry.ids.has(node)) registry.ids.set(node, 'p' + ++registry.next);
    const id = registry.ids.get(node);
    registry.nodes.set(id, node);
    return id;
  };
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const accessibleName = node => {
    if (!node) return '';
    const labelledBy = (node.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    return clean(labelledBy || node.getAttribute('aria-label') || Array.from(node.labels || []).map(l => l.textContent).join(' '));
  };
  const groupFor = node => {
    let group = null, context = '';
    for (let parent = node.parentElement, depth = 0; parent && parent !== document.body && depth < 6; parent = parent.parentElement, depth++) {
      const explicit = parent.matches('fieldset, [role="radiogroup"], [role="group"], [data-question], .question, .form-group');
      const heading = parent.querySelector(':scope > legend, :scope > label, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > p, :scope > .question-text, :scope > .question-title');
      let name = accessibleName(parent) || clean(heading?.textContent);
      if (!name && explicit) {
        const sibling = parent.firstElementChild;
        if (sibling && !sibling.matches('input, select, textarea, button')
          && !sibling.querySelector('input, select, textarea, button, [role="radio"], [role="checkbox"]')) name = clean(sibling.textContent);
      }
      if (name && (explicit || heading)) {
        if (!group) group = { node: parent, name };
        else if (!context && /\b(spouse|partner|child|children|mother|father|household member)\b/i.test(name)) context = name;
      }
    }
    return { ...(group || { node: null, name: '' }), context };
  };
  const nodes = bcInteractiveElements();
  const refs = new Map(nodes.map((node, i) => [node, i + 1]));
  const seen = new Set(), controls = [];
  for (const node of nodes) {
    const el = node.tagName === 'LABEL' ? node.control : node;
    if (!el || seen.has(el)) continue;
    const role = el.getAttribute('role') || '';
    const combo = role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox';
    const choice = ['radio', 'checkbox', 'switch'].includes(role) || ['radio', 'checkbox'].includes(el.type);
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !choice && !combo && !el.isContentEditable) continue;
    if (el.tagName === 'INPUT' && ['hidden', 'submit', 'reset', 'button', 'file', 'image', 'range', 'color', 'password'].includes(el.type)) continue;
    seen.add(el);
    const group = groupFor(el);
    const names = [accessibleName(el), el.placeholder, el.name, el.id, el.getAttribute('autocomplete')].map(clean).filter(Boolean);
    const options = [];
    if (el.tagName === 'SELECT') {
      Array.from(el.options).forEach((option, index) => options.push({
        index, label: clean(option.label || option.text), value: option.value, selected: option.selected,
        disabled: Boolean(option.disabled || option.parentElement?.disabled),
      }));
    } else if (combo) {
      const ids = (el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
      let roots = ids.map(id => document.getElementById(id)).filter(Boolean);
      if (!roots.length && el.getAttribute('aria-expanded') === 'true') {
        const lists = Array.from(document.querySelectorAll('[role="listbox"]')).filter(bcVisible);
        if (lists.length === 1) roots = lists;
      }
      const optionNodes = new Set(roots.flatMap(root => Array.from(root.querySelectorAll('[role="option"]'))));
      for (const option of optionNodes) {
        if (!bcVisible(option)) continue;
        options.push({ token: token(option), label: clean(option.textContent || accessibleName(option)),
          value: option.getAttribute('data-value') || '', selected: option.getAttribute('aria-selected') === 'true',
          disabled: option.getAttribute('aria-disabled') === 'true' });
      }
    }
    controls.push({
      token: token(el), ref: refs.get(node), tag: el.tagName.toLowerCase(), type: el.type || '', role,
      names, group: group.name, context: group.context, groupId: token(group.node),
      choiceGroup: choice ? (el.name ? token(el.form || el.getRootNode()) + ':' + el.name : token(group.node)) : '',
      value: el.value ?? '', text: clean(el.textContent),
      checked: el.checked ?? (el.getAttribute('aria-checked') === 'true'),
      expanded: el.getAttribute('aria-expanded') === 'true', combo, options,
      disabled: Boolean(el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]')),
      readOnly: Boolean(el.readOnly), multiple: Boolean(el.multiple),
      placeholder: el.placeholder || '', maxLength: el.maxLength ?? -1,
      min: el.min || '', max: el.max || '',
      formatHint: clean(el.getAttribute('aria-describedby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ')),
      valid: el.validity?.valid !== false,
    });
  }
  return controls;
}

// Target a retained DOM node, never a numeric ref that may have shifted after a dependent field changed.
export function profileTarget(token, focus = false) {
  const el = globalThis.__browserControlProfileNodes?.nodes.get(token);
  if (!el?.isConnected || el.disabled || el.readOnly || el.matches(':disabled') || el.closest('[inert]')
    || el.getAttribute('aria-disabled') === 'true') throw new Error('Profile control changed or is unavailable');
  const target = !focus && ['radio', 'checkbox'].includes(el.type)
    ? Array.from(el.labels || []).find(label => label.getBoundingClientRect().width > 0) || el : el;
  target.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
  if (focus) {
    el.focus();
    if (typeof el.select === 'function' && el.type !== 'date') el.select();
  }
  const r = target.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height,
    dateOrder: el.type === 'date' ? new Intl.DateTimeFormat(navigator.language)
      .formatToParts(new Date(2001, 10, 22)).map(p => p.type).filter(p => ['year', 'month', 'day'].includes(p)) : [] };
}

function componentOf(control) {
  const parts = new Set();
  for (const name of control.names) {
    const words = profileText(name).split(' ');
    if (words.some(w => ['day', 'dd'].includes(w))) parts.add('day');
    if (words.some(w => ['month', 'mm'].includes(w))) parts.add('month');
    if (words.some(w => ['year', 'yyyy', 'yy'].includes(w))) parts.add('year');
  }
  return parts.size === 1 ? [...parts][0] : null;
}

function ageInRange(label, age) {
  const text = String(label).toLowerCase().replace(/[–—]/g, '-').replace(/\byears?\b|\bold\b/g, '').trim();
  let m = /^(\d+)\s*(?:-|to)\s*(\d+)$/.exec(text);
  if (m) return age >= Number(m[1]) && age <= Number(m[2]);
  m = /^(?:under|below|less than)\s*(\d+)$/.exec(text);
  if (m) return age < Number(m[1]);
  m = /^(\d+)\s*(?:\+|and (?:over|above)|or (?:older|more))$/.exec(text);
  if (m) return age >= Number(m[1]);
  m = /^(\d+)\s*(?:or (?:younger|less)|and under)$/.exec(text);
  return m ? age <= Number(m[1]) : false;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function optionMatches(option, answer, key, component, profile, valueFallback = false) {
  const label = profileText(option.label);
  const aliases = profile.optionAliases[key] || {};
  const aliased = Object.entries(aliases).filter(([name]) => profileText(name) === label);
  if (aliased.length) return aliased.every(([, value]) => profileText(value) === profileText(answer));
  const match = text => {
    const normalized = profileText(text);
    if (typeof answer === 'boolean') return (answer ? ['yes', 'true'] : ['no', 'false']).includes(normalized);
    if (component === 'month') return normalized === MONTHS[answer - 1] || normalized === MONTHS[answer - 1]?.slice(0, 3)
      || (/^\d+$/.test(normalized) && Number(normalized) === answer);
    if (component === 'day' || component === 'year') return /^\d+$/.test(normalized) && Number(normalized) === answer;
    if (profileText(key) === 'age' && typeof answer === 'number' && ageInRange(text, answer)) return true;
    return normalized === profileText(answer);
  };
  // Date components and yes/no choices must follow labels, rather than guessing opaque numeric encodings.
  return match(option.label) || (valueFallback && !component && typeof answer !== 'boolean' && match(option.value));
}

function matchingOption(options, answer, key, component, profile) {
  const labelled = options.filter(option => optionMatches(option, answer, key, component, profile));
  const found = labelled.length ? labelled : options.filter(option => optionMatches(option, answer, key, component, profile, true));
  return found.length === 1 && !found[0].disabled ? found[0] : null;
}

function formattedDate(control, date) {
  if (control.type === 'date') return [date.year, String(date.month).padStart(2, '0'), String(date.day).padStart(2, '0')].join('-');
  const hint = control.placeholder + ' ' + control.formatHint + ' ' + control.names.join(' ');
  const formats = [...hint.matchAll(/\b(yyyy|dd|mm)([\/.\-])(yyyy|dd|mm)\2(yyyy|dd|mm)\b/gi)];
  const unique = new Set(formats.map(m => m[0].toLowerCase()));
  if (unique.size !== 1) return null;
  const format = [...unique][0];
  if (!['yyyy', 'mm', 'dd'].every(part => format.includes(part))) return null;
  return format.replace(/yyyy|mm|dd/g, part => part === 'yyyy' ? String(date.year)
    : String(part === 'mm' ? date.month : date.day).padStart(2, '0'));
}

export function planProfileFields(profile, controls, now = new Date()) {
  const facts = { ...profile.values }, dob = parseProfileDate(birthDate(facts));
  if (!Object.hasOwn(facts, 'age') && dob) {
    facts.age = now.getFullYear() - dob.year - (now.getMonth() + 1 < dob.month
      || (now.getMonth() + 1 === dob.month && now.getDate() < dob.day) ? 1 : 0);
  }
  const aliases = new Map();
  const add = (name, key) => {
    const normalized = profileText(name);
    if (!aliases.has(normalized)) aliases.set(normalized, new Set());
    aliases.get(normalized).add(key);
  };
  for (const key of Object.keys(facts)) {
    add(key, key);
    const normalized = profileText(key);
    for (const [canonical, names] of Object.entries(COMMON_NAMES)) {
      if (canonical === normalized || (canonical === 'date of birth' && DOB_KEYS.includes(normalized))) {
        add(canonical, key);
        for (const name of names) add(name, key);
      }
    }
  }
  for (const [name, key] of Object.entries(profile.aliases)) add(name, key);
  const lookup = names => new Set(names.flatMap(name => [...(aliases.get(profileText(name)) || [])]));
  const plans = controls.map(control => {
    const component = componentOf(control);
    const isChoice = ['radio', 'checkbox', 'switch'].includes(control.type) || ['radio', 'checkbox', 'switch'].includes(control.role);
    const scope = [control.context, control.group].filter(Boolean).join(' ');
    let keys = lookup(control.context ? [scope, ...control.names.map(name => scope + ' ' + name)]
      : control.names.map(name => control.group + ' ' + name));
    if (!keys.size && !control.context) {
      const contextual = /\b(spouse|partner|child|children|mother|father|household member)\b/.test(profileText(control.group));
      keys = contextual ? lookup([control.group])
        : lookup((isChoice || component) && control.group ? [control.group] : control.names);
      if (!keys.size && !contextual) keys = lookup([...control.names, control.group]);
    }
    const key = keys.size === 1 ? [...keys][0] : null;
    const plan = { control, key, component, kind: '', state: 'miss',
      reason: keys.size > 1 ? 'ambiguous_question' : 'map_miss',
      id: JSON.stringify([key, component, scope, control.names, control.tag, control.type, control.role]) };
    if (!key) return plan;
    plan.answer = facts[key];
    plan.reason = '';
    if (control.disabled || control.readOnly) { plan.reason = 'control_unavailable'; return plan; }
    if (control.multiple) { plan.reason = 'unsupported_control'; return plan; }
    const date = parseProfileDate(plan.answer);
    if (date) {
      if (component) plan.answer = date[component];
      else {
        plan.answer = formattedDate(control, date);
        if (plan.answer === null) { plan.reason = 'unknown_date_format'; return plan; }
      }
    } else if (component && DOB_KEYS.includes(profileText(key))) { plan.reason = 'invalid_date'; return plan; }
    const choiceGroup = controls.filter(c => c.choiceGroup && c.choiceGroup === control.choiceGroup
      && (c.role || c.type) === (control.role || control.type));
    if (isChoice) {
      const optionFor = c => ({ token: c.token, label: c.names[0] || c.text, value: c.value, disabled: c.disabled });
      if (control.type === 'radio' || control.role === 'radio') {
        const selected = matchingOption(choiceGroup.map(optionFor), plan.answer, key, component, profile);
        if (!selected) { plan.reason = 'no_unique_option'; return plan; }
        plan.answer = selected.token === control.token;
        if (!plan.answer) { plan.state = 'ignored'; return plan; }
      } else if (Array.isArray(plan.answer)) {
        const desired = plan.answer.map(value => matchingOption(choiceGroup.map(optionFor), value, key, component, profile));
        if (desired.some(option => !option)) { plan.reason = 'no_unique_option'; return plan; }
        plan.answer = desired.some(option => option.token === control.token);
      } else if (typeof plan.answer !== 'boolean') { plan.reason = 'checkbox_needs_boolean_or_array'; return plan; }
      plan.kind = 'click';
      plan.state = control.checked === plan.answer ? 'done' : 'pending';
    } else if (control.tag === 'select' || control.combo) {
      if (Array.isArray(plan.answer)) { plan.reason = 'unsupported_control'; return plan; }
      if (control.combo && !control.expanded && control.valid
        && [control.value, control.text].some(label => optionMatches({ label }, plan.answer, key, component, profile))) {
        plan.kind = 'option'; plan.state = 'done'; return plan;
      }
      const option = matchingOption(control.options, plan.answer, key, component, profile);
      if (!option) {
        if (control.combo && !control.expanded && !control.options.length) { plan.kind = 'open'; plan.state = 'pending'; }
        else plan.reason = 'no_unique_option';
        return plan;
      }
      plan.option = option;
      plan.kind = control.tag === 'select' ? 'select' : 'option';
      const committed = control.combo ? !control.expanded && (option.selected
        || [control.value, control.text].some(label => optionMatches({ label }, plan.answer, key, component, profile))) : option.selected;
      plan.state = committed && control.valid ? 'done' : 'pending';
    } else {
      if (Array.isArray(plan.answer) || !['input', 'textarea'].includes(control.tag)) { plan.reason = 'unsupported_control'; return plan; }
      if (date && component && control.type !== 'number' && (control.maxLength === 2
        || /^(dd|mm)$/i.test(control.placeholder))) plan.answer = String(plan.answer).padStart(2, '0');
      const text = String(plan.answer);
      if ((control.maxLength >= 0 && text.length > control.maxLength)
        || (control.type === 'number' && (!Number.isFinite(Number(text))
          || (control.min !== '' && Number(text) < Number(control.min)) || (control.max !== '' && Number(text) > Number(control.max))))) {
        plan.reason = 'answer_does_not_fit'; return plan;
      }
      plan.kind = control.type === 'date' ? 'date' : 'type';
      plan.state = String(control.value) === text && control.valid ? 'done' : 'pending';
    }
    return plan;
  });
  for (const plan of plans) {
    if (plan.key && plans.filter(other => other.id === plan.id).length > 1) {
      plan.state = 'miss'; plan.reason = 'ambiguous_control';
    }
  }
  // A split date needs identifiable day/month/year controls in the same question.
  for (const plan of plans) {
    if (!plan.component || !parseProfileDate(facts[plan.key])) continue;
    if (!plan.control.groupId && plan.control.names.some(name => profileText(name) === 'birth ' + plan.component)) continue;
    const siblings = plans.filter(p => p.key === plan.key && p.control.groupId === plan.control.groupId);
    if (!plan.control.groupId || ['day', 'month', 'year'].some(part => siblings.filter(p => p.component === part).length !== 1)) {
      plan.state = 'miss'; plan.reason = 'incomplete_date_group';
    }
  }
  const priority = p => p.component ? ({ year: 0, month: 1, day: 2 })[p.component]
    : ({ country: 0, state: 1, city: 2, pincode: 3 })[profileText(p.key)] ?? 4;
  return plans.sort((a, b) => priority(a) - priority(b));
}

export async function fillProfileFields(profile, io, { maxFields = 50, timeoutMs = 120000 } = {}) {
  const started = Date.now(), attempted = new Set(), verified = new Set(), failures = new Map(), attempts = new Map();
  let plans = [], error = null, actions = 0;
  const read = async () => {
    if (Date.now() - started >= timeoutMs) throw Object.assign(new Error('Profile fill timed out'), { code: 'PROFILE_TIMEOUT' });
    plans = planProfileFields(profile, await io.read());
  };
  try {
    await read();
    while (actions < maxFields * 3) {
      const next = plans.find(p => p.state === 'pending' && !failures.has(p.id)
        && (attempted.has(p.id) || attempted.size < maxFields));
      if (!next) break;
      const count = (attempts.get(next.id) || 0) + 1;
      attempts.set(next.id, count);
      if (count > 2) { failures.set(next.id, 'verification_failed'); continue; }
      attempted.add(next.id);
      actions++;
      if (next.kind === 'open') {
        const originalValue = next.control.value;
        await io.act(next);
        // Lazy dropdowns may attach or load options after the opening click.
        for (let poll = 0; poll < 10; poll++) {
          await io.sleep(100);
          await read();
          const current = plans.find(p => p.id === next.id);
          if (current?.control.options.length) break;
        }
        let current = plans.find(p => p.id === next.id);
        if (current && current.state === 'miss' && current.control.tag === 'input' && current.control.expanded) {
          await io.act({ ...current, kind: 'type', answer: String(next.answer), search: true });
          for (let poll = 0; poll < 10; poll++) {
            await io.sleep(100);
            await read();
            current = plans.find(p => p.id === next.id);
            if (current?.option) break;
          }
          if (!current?.option) await io.act({ ...next, kind: 'type', answer: originalValue, search: true });
        }
        if (!current || current.state === 'miss' || current.kind === 'open') {
          await io.escape();
          failures.set(next.id, current?.reason || 'no_unique_option');
          await read();
        }
        // Opening/searching is preparation; allow the subsequent option click its own verification.
        attempts.set(next.id, 0);
        continue;
      }
      await io.act(next);
      await io.sleep(100);
      await read();
      let current = plans.find(p => p.id === next.id);
      const dependentKey = ({ country: 'state', state: 'city' })[profileText(next.key)];
      const dependentPart = ({ year: 'month', month: 'day' })[next.component];
      for (let poll = 0; poll < 10; poll++) {
        const dependent = dependentPart ? plans.find(p => p.key === next.key && p.component === dependentPart
          && p.control.group === next.control.group) : plans.find(p => p.key === dependentKey);
        const waiting = (dependentPart || (dependentKey && Object.hasOwn(profile.values, dependentKey)))
          && (!dependent || !['pending', 'done'].includes(dependent.state));
        if (current?.state === 'done' && !waiting) break;
        await io.sleep(100);
        await read();
        current = plans.find(p => p.id === next.id);
      }
      if (current?.state === 'done') verified.add(next.id);
      else failures.set(next.id, 'verification_failed');
    }
    await read();
  } catch (caught) {
    error = { errorCode: caught?.code || 'PROFILE_FILL_FAILED', message: caught?.message || String(caught) };
  }
  const summary = p => ({ key: p.key, component: p.component, question: [p.control.context, p.control.group].filter(Boolean).join(' ') || p.control.names[0] || '',
    ref: p.control.ref, control: p.control.combo ? 'combobox' : p.control.type || p.control.tag });
  const filled = [], alreadyFilled = [], remaining = [];
  for (const plan of plans) {
    if (plan.state === 'ignored') continue;
    if (plan.state === 'done' && (!attempted.has(plan.id) || verified.has(plan.id))) {
      (attempted.has(plan.id) ? filled : alreadyFilled).push(summary(plan));
    } else {
      remaining.push({ ...summary(plan), reason: failures.get(plan.id) || plan.reason
        || (error ? error.errorCode : 'field_limit') });
    }
  }
  return { success: !error && ![...failures.values()].includes('verification_failed'),
    filled, alreadyFilled, remaining, ...error };
}
