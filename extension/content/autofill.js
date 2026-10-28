// Application-form autofill — injected on demand by the side panel (never on its
// own) into every frame of the current tab. Exposes window.__trAutofill:
//   fill(data)        fill plain fields + attach the CV; returns a report and the
//                     dropdown widgets that need real keystrokes ("pending")
//   focusWidget(id)   focus a pending widget so the panel can type into it
//   pickOption(id, v) after typing: which option to choose (arrow-key steps) or click it
//   verify(id)        did the widget end up with a value?
//   collect()         the form's current values, for "Remember answers"
// React dropdowns (Greenhouse, Ashby, Workday) ignore script-made events, so the
// panel types into them through the DevTools protocol, which Chrome treats as a
// real keyboard. Runs in the extension's isolated world; page scripts can't see it.

(() => {
  if (window.__trAutofill) return;

  // ---------- text helpers ----------
  const clean = (s) => String(s || '').replace(/[✱*]/g, ' ').replace(/\s+/g, ' ').replace(/[:\s]+$/, '').trim().slice(0, 300);
  // Same normalization as backend routers/autofill.py question_key() — keep in sync.
  const qkey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && w !== 'required' && w !== 'optional').join(' ').slice(0, 300);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const humanize = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-[\].]+/g, ' ');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!(el && el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';

  const US_STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
    DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  };
  const STATE_ABBR = Object.fromEntries(Object.entries(US_STATES).map(([a, n]) => [n.toLowerCase(), a]));
  const COUNTRY_ALIASES = { 'united states': ['united states of america', 'usa', 'us', 'u s', 'america'] };

  // Every way a value may be spelled in an option list ("TX" ↔ "Texas", "United States" ↔ "USA").
  function variants(value) {
    const v = norm(value);
    const out = new Set([v]);
    if (US_STATES[String(value).toUpperCase()]) out.add(norm(US_STATES[String(value).toUpperCase()]));
    if (STATE_ABBR[v]) out.add(STATE_ABBR[v].toLowerCase());
    for (const a of COUNTRY_ALIASES[v] || []) out.add(a);
    return [...out].filter(Boolean);
  }

  // Index of the option whose text best matches the wanted value; -1 when nothing fits.
  function bestIndex(texts, value) {
    const want = variants(value);
    let best = -1, bestScore = 0;
    texts.forEach((raw, i) => {
      const t = norm(raw);
      let score = 0;
      if (!t) score = 0;
      else if (want.includes(t)) score = 100;
      else if (want.some((w) => t.startsWith(w + ' ') || w.startsWith(t + ' '))) score = 70;
      else if (want.some((w) => w.length >= 3 && t.includes(w))) score = 50;
      else if (want.some((w) => t.length >= 3 && w.includes(t))) score = 40;
      if (score > bestScore) { best = i; bestScore = score; }
    });
    return best;
  }

  // ---------- field → profile value rules ----------
  const AUTOCOMPLETE = {
    'given-name': 'first_name', 'family-name': 'last_name', name: 'full_name', email: 'email',
    tel: 'phone', 'tel-national': 'phone', 'street-address': 'street', 'address-line1': 'street',
    'address-level2': 'city', 'address-level1': 'state', 'postal-code': 'zip', country: 'country',
    'country-name': 'country', organization: 'current_company', 'organization-title': 'current_title', url: 'portfolio',
  };
  // [field, pattern, max label length, unless]. First match wins. 'skip' marks look-alikes
  // that must NOT receive a profile value. Short field names ("Phone", "City", "State") are
  // anchored or length-capped: a long label is a QUESTION ("Please state your notice period",
  // "Describe your mobile development experience") and must not get a profile value.
  const NOT_TOTAL_YEARS = /\b(with|in|using|on)\s+(?!total\b|this\b|the (field|industry)\b|industry\b|software (engineering|development)\b|(a |an )?(professional|similar|relevant)\b)\w|\byears of (?!(professional|relevant|work|total|industry|overall)\b)\w+ (\w+ )?experience\b/;
  const RULES = [
    ['skip', /\b(middle name|address line 2|apt|suite|phone (type|extension)|country code|confirm password|password)\b/, 80],
    ['skip', /\b(company|employer|school|university|reference|manager|emergency|referr\w*|user) name\b/, 80],
    // someone ELSE's contact details: referrer, reference, emergency contact, manager…
    ['skip', /\b(referr\w*|references?|emergency|manager|supervisor|recruiter)\b.*\b(e ?mail|phone|mobile|telephone|number|contact)\b|\b(e ?mail|phone|telephone|contact)\b.*\b(referr\w*|references?|emergency|manager|supervisor|recruiter)\b/, 200],
    ['first_name', /\b(first|given|fore|preferred first)\s*name\b|\bfname\b|^first$/, 80],
    ['last_name', /\b(last|family|sur)\s*name\b|\bsurname\b|\blname\b|^last$/, 80],
    ['full_name', /^(your |full |legal |candidate )?(full )?name$|\bfull name\b|\blegal name\b/, 80],
    ['email', /^(your |personal |primary )?e ?mail( address)?$|\be ?mail address\b|^e ?mail\b/, 40],
    ['phone', /^(your |personal |primary )?(mobile |cell |home |work )?(phone|telephone|mobile|cell)( number| no)?$|\b(phone|telephone) number\b/, 40],
    ['linkedin', /\blinked ?in\b/, 120],
    ['github', /\bgit ?hub\b/, 120],
    ['portfolio', /\b(portfolio|personal (web ?)?site|website|blog|other (url|link|website))\b/, 120],
    // salary before the address rules: "Please state your expected salary" is not a state field
    ['expected_salary', /\b(salary|compensation|pay|rate) (expectation|requirement|range)s?\b|\b(expected|desired) (salary|compensation|pay|rate)\b|\bexpected (hourly|daily|monthly|annual) (rate|salary|pay)\b|\b(hourly|daily) rate\b/, 160],
    ['address_full', /^(full |postal |mailing |current )?address$|^(postal|mailing) address\b/, 40],
    ['street', /\b(street( address)?|address line 1|address 1|home address)\b/, 40],
    ['city', /^(current )?(city|town)( of residence)?$|^city town$|\blocation city\b|^city\b/, 30],
    ['state', /^(current )?(state|province|region)( of residence)?$|^state (province|or province|region)$/, 30],
    ['zip', /^(zip|postal|post)( code)?$|\bzip( code)?\b|\bpostal code\b|\bpostcode\b/, 30],
    ['country', /^(country|country of residence|current country)\b/, 80],
    ['location', /^(current )?location\b|\bwhere are you (currently )?(located|based)\b|\bwhere do you (currently )?live\b|\bcurrent city\b|\b(city|where)\b.*\b(reside|live|located|based)\b/, 120],
    ['current_company', /\b(current|most recent|present) (company|employer)\b|^(company|employer)( name)?$/, 80],
    ['current_title', /\b(current|most recent) (job )?(title|role|position)\b|^(job )?title$/, 80],
    ['university', /^(school|university|college|institution)( name)?$|\bschool name\b|\buniversity name\b/, 80],
    ['degree', /^degree\b|\bhighest degree\b|\bdegree (type|level)\b/, 80],
    ['graduation_year', /\bgraduat\w* (year|date)\b/, 80],
    // total years only — "years of experience with Rust" is a per-technology question
    ['years_experience', /\b(total )?years of (professional |relevant |work |industry |overall )?experience\b|\bhow many years\b/, 160, NOT_TOTAL_YEARS],
  ];

  function classify(f, labels = {}) {
    const ac = (f.el.getAttribute?.('autocomplete') || '').toLowerCase().split(/\s+/).pop();
    if (AUTOCOMPLETE[ac]) return AUTOCOMPLETE[ac];
    const key = qkey(f.label);
    if (key && labels[key]) return labels[key];
    const label = norm(f.label);
    const attrs = norm(humanize(`${f.el.name || ''} ${f.el.id || ''}`));
    for (const [field, re, max, unless] of RULES) {
      if (label && unless && unless.test(label)) continue;
      if ((label && label.length <= max && re.test(label)) || (!label && re.test(attrs))) return field;
    }
    // A bare name/id like "email" or "phone" when the visible label said nothing useful.
    if (!label || label.length <= 40) {
      for (const [field, re, , unless] of RULES) {
        if (attrs && attrs.length <= 40 && !(unless && unless.test(attrs)) && re.test(attrs)) return field;
      }
    }
    return null;
  }

  // Salary: only when the question's currency / period (if it names one) match the
  // profile's — a USD figure must never go into "…salary in EUR". A number-only field
  // gets the bare amount; otherwise the readable range ("120,000–140,000 USD per year").
  const CURRENCY_RE = {
    USD: /\b(usd|us dollars?)\b|\$/, EUR: /\b(eur|euros?)\b|€/, GBP: /\b(gbp|pounds? sterling)\b|£/,
    RON: /\b(ron|lei)\b/, PLN: /\b(pln|zloty|złoty)\b/, BGN: /\b(bgn|leva)\b/, CAD: /\b(cad)\b/, CHF: /\b(chf)\b/,
  };
  const PERIOD_RE = { hour: /\b(hour|hourly)\b/, day: /\b(day|daily)\b/, month: /\b(month|monthly)\b/, year: /\b(annual|annually|yearly|year|per annum|p\.?a\.?)\b/ };
  function salaryValue(f, v) {
    if (!v.expected_salary) return '';
    const text = String(f.label || '').toLowerCase();
    const asked = Object.keys(CURRENCY_RE).find((c) => CURRENCY_RE[c].test(text));
    if (asked && v.salary_currency && asked !== v.salary_currency) return '';
    const per = Object.keys(PERIOD_RE).find((k) => PERIOD_RE[k].test(text));
    if (per && v.salary_period && per !== v.salary_period) return '';
    const numeric = f.el.type === 'number' || f.el.inputMode === 'numeric' || /\b(numbers? only|digits only)\b/.test(text);
    return numeric ? (v.expected_salary_amount || '') : v.expected_salary;
  }
  function profileValue(f, field, values) {
    if (!field) return '';
    if (field === 'expected_salary') return salaryValue(f, values);
    return values[field] || '';
  }

  // Words that may differ between two wordings of the SAME question. Anything else that
  // differs — a country, a company, a technology — makes it a different question: "authorized
  // to work in the United Kingdom" must not reuse the answer for "…the United States".
  const FILLER = new Set(('the and you your are for with this that have has any our will can would now future '
    + 'currently legally please its all from into been ever able ready willing does did were was who which '
    + 'what when where how being also there their they them per such other others some more most yes not '
    + 'require required requires need needs position role job company').split(' '));
  function exactAnswer(label, answers) {
    const key = qkey(label);
    return key ? (answers.find((a) => a.question_key === key)?.answer || '') : '';
  }
  function findAnswer(label, answers) {
    const key = qkey(label);
    if (!key) return '';
    const exact = exactAnswer(label, answers);
    if (exact) return exact;
    // Same question, slightly different wording on another site.
    const tok = (s) => new Set(s.split(' ').filter((w) => w.length > 2 || /\d/.test(w)));
    const a = tok(key);
    let best = null, bestScore = 0;
    for (const ans of answers) {
      const b = tok(ans.question_key);
      const diff = [...a].filter((w) => !b.has(w)).concat([...b].filter((w) => !a.has(w)));
      if (diff.some((w) => !FILLER.has(w))) continue;
      const inter = [...a].filter((w) => b.has(w)).length;
      const score = inter / (a.size + b.size - inter || 1);
      if (score > bestScore) { best = ans; bestScore = score; }
    }
    return bestScore >= 0.6 ? best.answer : '';
  }

  // ---------- label discovery ----------
  // Visible text only — dropdown hints like "No location found" sit hidden inside labels.
  function textOf(node) {
    if (!node) return '';
    const parts = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const p = t.parentElement;
      if (!p || p.closest('[aria-hidden="true"], option, script, style, select, textarea')) continue;
      if (!visible(p)) continue;
      parts.push(t.textContent);
    }
    return clean(parts.join(' '));
  }
  const byIds = (ids) => clean(String(ids || '').split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' '));
  const LABELISH = 'label, legend, h3, h4, h5, [class*="label" i], [class*="question" i], [class*="title" i], [data-automation-id*="label" i], [data-automation-id*="formLabel" i]';

  // The element each field's label came from — its "*" / "required" class marks a required question.
  const labelNode = new WeakMap();
  const labelled = (el, node, text) => { if (node) labelNode.set(el, node); return text; };

  function labelFor(el, group = false) {
    if (!group) {
      if (el.labels && el.labels.length) { const t = textOf(el.labels[0]); if (t) return labelled(el, el.labels[0], t); }
      if (el.getAttribute('aria-labelledby')) {
        const t = byIds(el.getAttribute('aria-labelledby'));
        if (t) return labelled(el, document.getElementById(el.getAttribute('aria-labelledby').split(/\s+/)[0]), t);
      }
      if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    }
    // A radio/checkbox group's question, or a custom widget's nearby label.
    const fs = el.closest('fieldset');
    if (fs?.querySelector('legend')) { const t = textOf(fs.querySelector('legend')); if (t) return labelled(el, fs.querySelector('legend'), t); }
    const grp = el.closest('[role="radiogroup"], [role="group"]');
    if (grp) {
      const t = grp.getAttribute('aria-label') || byIds(grp.getAttribute('aria-labelledby'));
      if (t) return clean(t);
    }
    // Nearest label-like element BEFORE the field, searching outward a few levels
    // (reverse order, so a previous question's label never wins over this one's).
    // Real <label>/<legend> first, so a help line under the label ("This should be
    // the location you're physically…") never stands in for the question itself.
    // The walk stops at a container that also holds ANOTHER field: past that point the
    // nearest label belongs to a sibling ("First name" above an unlabelled "Last name").
    const own = ownControls(el);
    const foreign = (node) => [...node.querySelectorAll('input:not([type="hidden"]), select, textarea, button[aria-pressed], [role="radio"]')]
      .some((c) => !own.has(c));
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4 && !foreign(node); depth++, node = node.parentElement) {
      for (const sel of ['label, legend', LABELISH]) {
        for (const cand of [...node.querySelectorAll(sel)].reverse()) {
          if (cand.contains(el) || cand.querySelector('input, select, textarea')) continue;
          if (cand.control && own.has(cand.control)) continue;      // an option's own label ("Male"), not the question
          if (!(cand.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          const t = textOf(cand);
          if (t && t.length > 1) return labelled(el, cand, t);
        }
      }
      // Floating labels sit AFTER their input; inside a box holding only this field that's safe.
      // (Not for a radio/checkbox group: the labels after its inputs are the OPTIONS.)
      for (const cand of group ? [] : node.querySelectorAll('label')) {
        if (cand.contains(el) || cand.querySelector('input, select, textarea')) continue;
        if (cand.control && !own.has(cand.control)) continue;    // labels another field
        const t = textOf(cand);
        if (t && t.length > 1) return labelled(el, cand, t);
      }
    }
    const described = byIds(el.getAttribute('aria-describedby'));
    return clean(el.getAttribute('placeholder') || (described.length <= 80 ? described : '') || humanize(el.name || el.id || ''));
  }

  // The controls that belong to this field: itself, its radio/checkbox group (same name),
  // or the sibling buttons + hidden input of a choice-button group.
  function ownControls(el) {
    const set = new Set([el]);
    if ((el.type === 'radio' || el.type === 'checkbox') && el.name) {
      const scope = el.form || document;
      for (const c of scope.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)) set.add(c);
    }
    if (el.matches?.('button[aria-pressed], [role="radio"]:not(input)') && el.parentElement) {
      for (const c of el.parentElement.querySelectorAll('button, [role="radio"], input')) set.add(c);
    }
    return set;
  }

  // The QUESTION a radio/checkbox group sits under, from its fieldset legend or an ARIA group.
  function groupQuestion(el) {
    const fs = el.closest('fieldset');
    const legend = fs?.querySelector('legend');
    if (legend && textOf(legend)) return textOf(legend);
    const grp = el.closest('[role="radiogroup"], [role="group"]');
    return grp ? clean(grp.getAttribute('aria-label') || byIds(grp.getAttribute('aria-labelledby'))) : '';
  }

  function isRequired(f) {
    const els = f.options ? f.options.map((o) => o.el) : [f.el];
    if (els.some((e) => e.required || e.getAttribute('aria-required') === 'true')) return true;
    const node = labelNode.get(f.el);
    return !!node && (/[*✱]/.test(node.textContent) || /required/i.test(String(node.className)));
  }

  const optionLabel = (input) => (input.labels && input.labels.length ? textOf(input.labels[0]) : '')
    || clean(input.getAttribute('aria-label')) || clean(input.closest('label')?.textContent) || clean(input.value);

  // ---------- scan ----------
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search']);
  let seq = 0;
  const idOf = (el) => el.dataset.trAf || (el.dataset.trAf = String(++seq));
  const byId = (id) => document.querySelector(`[data-tr-af="${CSS.escape(String(id))}"]`);

  function scan() {
    const fields = [];
    const groups = new Map();
    // Choice buttons (Ashby's Yes/No, custom role="radio" pills), grouped by parent.
    const buttonGroups = new Map();
    for (const b of document.querySelectorAll('button[aria-pressed], [role="radio"]:not(input)')) {
      if (!visible(b)) continue;
      if (!buttonGroups.has(b.parentElement)) buttonGroups.set(b.parentElement, []);
      buttonGroups.get(b.parentElement).push(b);
    }
    for (const [parent, btns] of [...buttonGroups]) {
      if (btns.length < 2) { buttonGroups.delete(parent); continue; }
      fields.push({ el: btns[0], kind: 'buttons', options: btns.map((b) => ({ el: b, text: clean(b.textContent) })), label: labelFor(btns[0], true) });
    }
    for (const el of document.querySelectorAll('input, textarea, select')) {
      const type = (el.type || '').toLowerCase();
      if (el.disabled || el.readOnly || SKIP_TYPES.has(type)) continue;
      if (buttonGroups.has(el.parentElement)) continue;   // the hidden input behind choice buttons
      if (type === 'file') { fields.push({ el, kind: 'file', label: labelFor(el) }); continue; }
      if (type === 'radio' || type === 'checkbox') {
        const key = `${type}:${el.name || labelFor(el, true)}`;
        if (!groups.has(key)) {
          const g = { el, kind: type, options: [], label: labelFor(el, true) };
          groups.set(key, g); fields.push(g);
        }
        groups.get(key).options.push({ el, text: optionLabel(el) });
        continue;
      }
      // Invisible helper inputs (react-select's "required" proxy etc.) are not questions.
      // (A react-select input goes transparent once an option is chosen — still a field.)
      const combo = el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list';
      if (!visible(el) || el.getAttribute('aria-hidden') === 'true' || (!combo && getComputedStyle(el).opacity === '0')) continue;
      fields.push({ el, kind: el.tagName === 'SELECT' ? 'select' : (combo ? 'combo' : 'text'), label: labelFor(el) });
    }
    // Custom dropdown buttons (Workday "Select One", headless UI listboxes).
    for (const el of document.querySelectorAll('button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"]')) {
      if (visible(el) && !el.disabled) fields.push({ el, kind: 'listbox', label: labelFor(el) });
    }
    // A lone checkbox ("I accept the privacy notice") is a yes/no question in its own words —
    // labelled by its own text unless a fieldset/ARIA group names the question. (Taking the
    // nearest label above it used to file "Yes" under the PREVIOUS question.)
    for (const f of fields) {
      if (f.kind === 'checkbox' && f.options.length === 1) {
        f.label = groupQuestion(f.el) || f.options[0].text || f.label;
      }
    }
    return fields.filter((f) => f.label || f.kind === 'file');
  }

  // ---------- values ----------
  const PLACEHOLDER = /^(select|choose|please|--|none|start typing)/i;
  function widgetValue(f) {
    if (f.kind === 'text') return f.el.value.trim();
    if (f.kind === 'combo') {
      if (f.el.value.trim()) return f.el.value.trim();
      // The select's own control box — not react-select's inner "input-container".
      const box = f.el.closest('[class*="control" i]') || f.el.closest('[class*="container" i]:not([class*="input" i])');
      const v = clean(box?.querySelector('[class*="single-value" i], [class*="singleValue"], [class*="multi-value" i]')?.textContent);
      return v && !PLACEHOLDER.test(v) ? v : '';
    }
    if (f.kind === 'select') { const t = f.el.selectedOptions[0]?.text || ''; return f.el.value && !PLACEHOLDER.test(t) ? clean(t) : ''; }
    if (f.kind === 'radio') return f.options.find((o) => o.el.checked)?.text || '';
    if (f.kind === 'buttons') return f.options.find((o) => o.el.getAttribute('aria-pressed') === 'true' || o.el.getAttribute('aria-checked') === 'true')?.text || '';
    if (f.kind === 'checkbox') return f.options.length === 1 ? (f.options[0].el.checked ? 'Yes' : '') : f.options.filter((o) => o.el.checked).map((o) => o.text).join(', ');
    if (f.kind === 'listbox') { const t = clean(f.el.textContent); return t && !PLACEHOLDER.test(t) ? t : ''; }
    return '';
  }

  // ---------- set values like a person would ----------
  function setNative(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus();
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const YES = /^(yes|true|y|1|checked|agree|i agree|accept)$/i;

  function fillPlain(f, value) {
    switch (f.kind) {
      case 'text': setNative(f.el, value); f.el.blur(); return true;
      case 'select': {
        const opts = [...f.el.options];
        const i = bestIndex(opts.map((o) => o.text), value);
        if (i < 0) return false;
        setNative(f.el, opts[i].value); return true;
      }
      case 'radio':
      case 'buttons': {
        const i = bestIndex(f.options.map((o) => o.text), value);
        if (i < 0) return false;
        f.options[i].el.click(); return true;
      }
      case 'checkbox': {
        if (f.options.length === 1) { if (YES.test(value) && !f.options[0].el.checked) f.options[0].el.click(); return YES.test(value); }
        let any = false;
        for (const w of value.split(/\s*[,;]\s*/).filter(Boolean)) {
          const i = bestIndex(f.options.map((o) => o.text), w);
          if (i >= 0 && !f.options[i].el.checked) { f.options[i].el.click(); any = true; }
        }
        return any;
      }
    }
    return false;
  }

  function flash(el, ok) {
    const target = el.type === 'radio' || el.type === 'checkbox' ? (el.closest('fieldset, [role="radiogroup"], [role="group"]') || el) : el;
    const prev = target.style.boxShadow;
    target.style.boxShadow = `0 0 0 2px ${ok ? '#10b981' : '#f59e0b'}`;
    setTimeout(() => { target.style.boxShadow = prev; }, 6000);
  }

  // ---------- CV upload ----------
  function resumeInput(fields) {
    const files = fields.filter((f) => f.kind === 'file');
    const own = (f) => norm(humanize(`${f.label} ${f.el.name} ${f.el.id} ${f.el.getAttribute('aria-label') || ''}`));
    const near = (f) => (f.el.closest('[class*="resume" i], [class*="cv" i], [data-automation-id*="resume" i]') ? 'resume' : '');
    const isCover = (f) => /\bcover\b/.test(own(f));
    // The input's own name/label beats a "resume" wrapper (Ashby's "autofill from resume" box).
    return files.find((f) => /\b(resume|cv|curriculum)\b/.test(own(f)) && !isCover(f))
      || files.find((f) => near(f) && !isCover(f))
      || (files.filter((f) => !isCover(f)).length === 1 ? files.find((f) => !isCover(f)) : null);
  }

  function attachCv(input, cv) {
    const bytes = Uint8Array.from(atob(cv.base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], cv.filename, { type: 'application/pdf' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- dropdown options (after the panel typed / opened) ----------
  const OPTION_SEL = '[role="option"], [class*="dropdown" i] li, [class*="suggestion" i], [class*="autocomplete" i] li, .pac-item';
  function visibleOptions(f) {
    const own = document.getElementById(f.el.getAttribute('aria-controls') || f.el.getAttribute('aria-owns') || '');
    const pool = own ? own.querySelectorAll(OPTION_SEL) : document.querySelectorAll(OPTION_SEL);
    // The phone-country picker (intl-tel-input) is always in the DOM — never ours.
    return [...pool].filter((o) => visible(o) && !o.closest('.iti, [class*="iti__"]') && clean(o.textContent));
  }

  // ---------- the "Apply" step on posting pages (Lever, Ashby, company sites) ----------
  const APPLY_RE = /^(apply|apply now|apply for this (job|position|role)|apply to this job|application|i'?m interested|start application)$/i;
  function applyTrigger() {
    for (const el of document.querySelectorAll('a, button, [role="button"], [role="tab"]')) {
      if (visible(el) && APPLY_RE.test(clean(el.textContent))) return el;
    }
    return null;
  }

  // ---------- public ----------
  const pending = new Map();   // id → { kind, value, location, label }

  async function fill(data) {
    const report = { fields: 0, filled: [], unfilled: [], cv: 'none', pending: [], openedForm: false };
    let fields = scan();
    report.fields = fields.filter((f) => f.kind !== 'file').length;
    const miss = (f) => { report.unfilled.push({ label: f.label, required: isRequired(f) }); };

    // A posting page, not the form yet: press its Apply button — the panel waits and runs again.
    if (!data.noApply && report.fields < 2 && !fields.some((f) => f.kind === 'file') && window === window.top) {
      const trigger = applyTrigger();
      if (trigger) { trigger.click(); report.openedForm = true; return report; }
    }

    // CV first: Lever / Ashby / Greenhouse parse the upload and may prefill fields,
    // which we then leave alone (only empty fields are filled below).
    const cvInput = resumeInput(fields);
    if (cvInput) {
      if (!data.cv) report.cv = 'missing';
      else if (cvInput.el.files?.length) report.cv = 'already';
      else {
        try { attachCv(cvInput.el, data.cv); report.cv = 'attached'; await sleep(1500); fields = scan(); }
        catch { report.cv = 'failed'; }
      }
    }

    for (const f of fields) {
      if (f.kind === 'file' || !f.el.isConnected || widgetValue(f)) continue;
      const field = classify(f, data.labels || {});
      // What the bidder taught for THIS exact question wins (it corrects a wrong rule match);
      // then the profile's value; then a learned answer to the same question worded differently.
      const taught = exactAnswer(f.label, data.answers || []);
      if (field === 'skip' && !taught) continue;
      const value = taught || profileValue(f, field === 'skip' ? null : field, data.values) || findAnswer(f.label, data.answers || []);
      if (!value) { miss(f); flash(f.el, false); continue; }
      const location = field === 'location' || field === 'city';
      // Dropdowns, and location boxes that suggest places as you type, need real keystrokes.
      if (f.kind === 'combo' || f.kind === 'listbox' || (f.kind === 'text' && field === 'location')) {
        const id = idOf(f.el);
        const item = { id, kind: f.kind === 'listbox' ? 'listbox' : 'combo', value, location, label: f.label, required: isRequired(f) };
        pending.set(id, item);
        report.pending.push(item);
        continue;
      }
      let ok = false;
      try { ok = fillPlain(f, value); } catch { ok = false; }
      if (ok) report.filled.push(f.label); else miss(f);
      flash(f.kind === 'buttons' ? f.el.parentElement : (f.kind === 'radio' || f.kind === 'checkbox' ? f.options[0].el : f.el), ok);
    }
    return report;
  }

  function focusWidget(id) {
    const el = byId(id); if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    return document.activeElement === el;
  }

  // Returns { mode: 'keys', steps } — press ArrowDown `steps` times (negative = up) then
  // Enter; { mode: 'clicked' } — a plain-JS list we clicked; { mode: 'wait' } — no
  // options showing yet; { mode: 'nomatch' } — options, but none fits the value.
  function pickOption(id) {
    const el = byId(id), p = pending.get(id);
    if (!el || !p) return { mode: 'nomatch' };
    const opts = visibleOptions({ el });
    if (!opts.length) return { mode: 'wait' };
    let i = bestIndex(opts.map((o) => o.textContent), p.value);
    if (i < 0 && p.location) i = 0;          // place search: the top suggestion is the typed city
    if (i < 0) return { mode: 'nomatch' };
    if (opts[i].getAttribute('role') !== 'option') { opts[i].click(); return { mode: 'clicked' }; }
    const active = document.getElementById(el.getAttribute('aria-activedescendant') || '');
    let cur = opts.findIndex((o) => o === active || o.getAttribute('aria-selected') === 'true' || /focused|highlight|active/i.test(o.className));
    if (cur < 0) cur = p.kind === 'listbox' ? -1 : 0;
    return { mode: 'keys', steps: i - cur };
  }

  function verify(id) {
    const el = byId(id), p = pending.get(id);
    if (!el || !p) return false;
    const kind = el.matches('button, [role="button"]') ? 'listbox' : (el.getAttribute('role') === 'combobox' ? 'combo' : 'text');
    const ok = !!widgetValue({ el, kind });
    flash(el, ok);
    return ok;
  }

  function collect() {
    const fields = scan().filter((f) => f.kind !== 'file');
    if (fields.length < 3) return [];   // not an application form (search bar, newsletter box…)
    const out = [];
    for (const f of fields) {
      // Essays ("Why us?") are written for one company — never reuse them.
      if (f.el.tagName === 'TEXTAREA') continue;
      const value = widgetValue(f);
      if (!value || value.length > 200) continue;
      const field = classify(f);
      out.push({ question: f.label, value, field: field && field !== 'skip' ? field : '' });
    }
    return out;
  }

  window.__trAutofill = { fill, focusWidget, pickOption, verify, collect };
})();
