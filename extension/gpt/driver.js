/* chatgpt.com driver — runs in the ChatGPT TABS the extension opens (gpt/runner.js: real tabs, in
 * the background); registered as a content script for chatgpt.com once ChatGPT is connected. In
 * the user's own ChatGPT tabs it does nothing (the worker doesn't know those tabs).
 *
 * On load the driver asks the service worker for its tab's task (gpt_ready → { ours, task }; the
 * worker tells tabs apart by their id), does it, and reports back (gpt_done) — a fresh message,
 * so a service worker suspended meanwhile wakes up for it. While working it sends a
 * heartbeat (gpt_alive), which also keeps the service worker running. The conversation is
 * reported the moment ChatGPT opens it (gpt_alive with its URL), so the server can delete it
 * even if this frame never finishes; every result of write / answers carries it too.
 *
 * task.kind
 *   write    paste task.prompt → resume JSON; then, in the SAME conversation, task.answersPrompt
 *            (if any) → answers.   result { ok, resume_json, answers?, answersError?, conversation }
 *   answers  paste task.prompt (in the job's own conversation) → { ok, answers, conversation }
 *   delete   hide (= delete) conversations task.ids via ChatGPT's own web API → { ok, done, failed }
 *   check    only the account check below → { ok, plan }
 * Before any check / write / answers, the signed-in account must be on a PAID ChatGPT plan
 * (Plus, Pro, Team / Business, Enterprise, Edu…): the Free plan is refused (kind free_plan), and
 * so is an account whose plan can't be confirmed (kind plan_unknown) — never let Free through.
 * failure:   { ok: false, kind: needs_login | free_plan | plan_unknown | rate_limited | timeout | invalid_json | no_composer | error, error }
 * The DOM selectors are the fragile part; each lookup tries several known variants. */
(() => {
  if (window.top !== window || window.__trGptDriver) return;   // the tab's page only (not ChatGPT's own frames)
  window.__trGptDriver = true;
  let FRAME = '';                                                 // this tab's work id, from the worker

  // A pause that background tabs don't stretch: Chrome slows a hidden tab's timers (to once a MINUTE
  // after 5 minutes hidden), so the service worker — whose timers run normally — answers when the time
  // is up. The page's own timer is the fallback (the worker can't be reached after an update).
  const sleep = (ms) => new Promise((resolve) => {
    let done = false; const end = () => { if (!done) { done = true; resolve(); } };
    setTimeout(end, ms);
    try { chrome.runtime.sendMessage({ type: 'gpt_sleep', ms }).then(end, () => {}); } catch { /* timer only */ }
  });
  const q = (sels, root = document) => { for (const s of sels) { try { const el = root.querySelector(s); if (el) return el; } catch { /* bad selector */ } } return null; };
  // This page lives in a background tab that may not be laid out or painted: "visible" and
  // "text" must not depend on layout. Visible = in the document and not hidden by CSS;
  // text = the text content without <script>/<style> (innerText of an unrendered element
  // falls back to the raw source, scripts included).
  function visible(el) {
    if (!el || !el.isConnected) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return false;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }
  function textOf(el) {
    if (!el) return '';
    if (el.getClientRects().length && typeof el.innerText === 'string') return el.innerText;   // laid out: innerText is right
    const c = el.cloneNode(true);
    c.querySelectorAll('script,style,noscript,template').forEach((n) => n.remove());
    c.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    c.querySelectorAll('p,div,li,pre,h1,h2,h3,h4,tr').forEach((n) => n.append('\n'));
    return (c.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  }
  const bodyText = () => textOf(document.body).slice(0, 20000);

  const SEL = {
    composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea[data-id]', 'form textarea', '[contenteditable="true"][data-virtualkeyboard]'],
    send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send" i]', 'form button[type="submit"]'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]', '[data-testid="stop-button"]'],
    login: ['[data-testid="login-button"]', 'a[href*="/auth/login"]', 'button[data-testid="welcome-login-button"]'],
  };
  const LIMIT_RE = /(message|usage) (limit|cap)|too many requests|rate limit|try again (later|in)|unusual activity|verify you are human/i;
  const limitTextPresent = () => LIMIT_RE.test(bodyText());
  const composerUsable = () => {
    const c = q(SEL.composer);
    return !!c && visible(c) && !c.disabled && c.getAttribute('aria-disabled') !== 'true' && c.getAttribute('contenteditable') !== 'false';
  };
  // A HARD blocker only: ChatGPT often shows a "usage limit" banner while it keeps
  // answering with a fallback model — that must not stop a generation.
  function detectBlocker() {
    // Logged out, ChatGPT still lets you chat — but those chats can't be reopened for the
    // job's questions or deleted afterwards. A visible "Log in" button means: sign in first.
    if (/^\/auth\//.test(location.pathname) || visible(q(SEL.login))) return 'needs_login';
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
    if (limitTextPresent() && (!composerUsable() || (dialog && LIMIT_RE.test(textOf(dialog))))) return 'rate_limited';
    return '';
  }
  // Wait until fn() returns something. Checked on every change of the page, not only on a timer:
  // Chrome slows timers down in background tabs (to once a MINUTE in a tab hidden 5+ minutes),
  // which made a finished reply wait long before it was noticed. DOM changes are seen at once.
  // (Checks are bunched: one per burst of changes, through a MessageChannel — never throttled.)
  function waitFor(fn, ms, step = 500, first = 0) {
    return new Promise((resolve) => {
      let done = false, queued = false;
      const endAt = Date.now() + ms;
      const ch = new MessageChannel();
      const finish = (v) => { if (done) return; done = true; obs.disconnect(); ch.port1.close(); resolve(v); };
      const check = () => {
        if (done) return;
        let v = null; try { v = fn(); } catch { /* the page is changing */ }
        if (v) finish(v); else if (Date.now() >= endAt) finish(null);
      };
      ch.port1.onmessage = () => { queued = false; check(); };
      const obs = new MutationObserver(() => { if (!queued && !done) { queued = true; ch.port2.postMessage(0); } });
      obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      (async () => { if (first) await sleep(first); while (!done) { check(); if (!done) await sleep(step); } })();
    });
  }

  async function typePrompt(composer, prompt) {
    composer.focus();
    if (composer.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(composer, prompt); composer.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    // ProseMirror: execCommand goes through the editor's own input handling.
    document.execCommand('selectAll', false, null);
    let ok = document.execCommand('insertText', false, prompt);
    const typed = () => textOf(composer).trim().length >= Math.min(prompt.length, 200) * 0.8;
    if (ok && (typed() || await waitFor(typed, 600, 100))) return true;   // (normally at once)
    try {
      const dt = new DataTransfer(); dt.setData('text/plain', prompt);
      composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await waitFor(typed, 600, 100);
    } catch { /* no DataTransfer — fall through */ }
    if (!typed()) { try { composer.textContent = prompt; composer.dispatchEvent(new Event('input', { bubbles: true })); await waitFor(typed, 400, 100); } catch { /* */ } }
    ok = typed();
    return ok;
  }
  async function clickSend(composer) {
    const btn = await waitFor(() => { const b = q(SEL.send); return b && !b.disabled && visible(b) ? b : null; }, 8000, 100);
    if (btn) { btn.click(); return; }
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }

  // ---- the reply: several strategies, never dependent on one selector
  const REPLY_SELS = ['[data-message-author-role="assistant"]', 'article[data-testid^="conversation-turn"]', 'div[data-testid^="conversation-turn"]', '.markdown', '[class*="markdown" i]'];
  function replyCandidates() {
    for (const s of REPLY_SELS) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(s)); } catch { continue; }
      list = list.filter((el) => !el.closest('[data-message-author-role="user"]') && !el.closest('form') && textOf(el).trim());
      if (list.length) return list;
    }
    const main = document.querySelector('main'); return main ? [main] : [document.body];
  }
  function lastReply() { const list = replyCandidates(); const el = list[list.length - 1]; return { el, text: textOf(el).trim(), count: list.length }; }

  // Done = the reply changed from the pre-send snapshot, is no longer streaming (no stop button)
  // and either holds what was asked for (ready(reply): the JSON parses — done AT ONCE) or its text
  // has stayed the same for 1.5 s.
  const signedOut = () => /^\/auth\//.test(location.pathname) || visible(q(SEL.login));
  async function waitForReply(baseline, timeoutMs, ready = () => false) {
    const started = await waitFor(() => q(SEL.stop) || (() => { const r = lastReply(); return r.count > baseline.count || r.text !== baseline.text; })(), 60_000, 250);
    if (!started && limitTextPresent()) return { kind: 'rate_limited' };
    let last = '', since = Date.now();
    const out = await waitFor(() => {
      if (q(SEL.stop)) { since = Date.now(); return null; }          // still writing (cheap: no text read)
      if (signedOut()) return { kind: 'needs_login' };
      const r = lastReply();
      const changed = r.count > baseline.count || r.text !== baseline.text;
      if (!changed || !r.text) { last = r.text; since = Date.now(); return null; }
      if (ready(r)) return { done: true };
      if (r.text !== last) { last = r.text; since = Date.now(); return null; }
      return Date.now() - since >= 1000 ? { done: true } : null;
    }, timeoutMs, 1000, 3000);   // a check after 3 s, then every second — and on every change of the page
    return out || { kind: 'timeout' };
  }

  // ---- the model: ChatGPT's model menu (top left). Tech questions are sent with a fast model (⚙ Settings
  // → ChatGPT models; "Instant" by default), and the menu is set back afterwards, so the next CV is
  // written by the model it was before. A CV model can be pinned the same way (task.model).
  // Items are found by their NAME ("Instant" also matches "GPT-5.1 Instant"). Best effort: no menu, or
  // no such model → the message goes with whatever is selected, never an error.
  const MODEL_BTN = ['button[data-testid="model-switcher-dropdown-button"]', 'button[aria-label*="model selector" i]',
    'button[aria-haspopup="menu"][aria-label*="model" i]'];
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const low = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const modelButton = () => { const b = q(MODEL_BTN); return b && visible(b) ? b : null; };
  const modelNow = (b) => low(`${b.getAttribute('aria-label') || ''} ${textOf(b)}`);
  const itemName = (el) => (textOf(el).split('\n').map((s) => s.trim()).find(Boolean) || '');
  const menuItems = () => Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]')).filter(visible);
  const hasWord = (text, w) => new RegExp(`(^|[^a-z0-9])${reEsc(low(w))}($|[^a-z0-9])`).test(low(text));
  function press(el, kinds) {
    for (const k of kinds) {
      const C = k.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new C(k, { bubbles: true, cancelable: true, button: 0, buttons: /down$/.test(k) ? 1 : 0, pointerType: 'mouse', isPrimary: true }));
    }
  }
  const closeMenu = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  async function openModelMenu(b) {
    const items = () => { const i = menuItems(); return i.length ? i : null; };
    press(b, ['pointerdown', 'mousedown']);                     // a Radix menu opens on pointer-down
    let got = await waitFor(items, 1000, 100);
    if (!got) { press(b, ['pointerup', 'mouseup', 'click']); got = await waitFor(items, 1200, 100); }   // others: on click
    return got || [];
  }
  function findItem(items, want) {
    const w = low(want), named = items.map((el) => ({ el, n: low(itemName(el)) }));
    return (named.find((x) => x.n === w) || named.find((x) => x.n.startsWith(`${w} `)) || named.find((x) => hasWord(x.n, w))
      || named.find((x) => low(x.el.getAttribute('data-testid')).includes(w.replace(/ /g, '-'))))?.el || null;
  }
  function selectedItem(items, now) {
    const marked = items.find((el) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked');
    if (marked) return marked;
    const named = items.filter((el) => { const n = low(itemName(el)); return n && hasWord(now, n); })
      .sort((a, b) => itemName(b).length - itemName(a).length);
    return named[0] || items.find((el) => /^auto\b/.test(low(itemName(el)))) || null;   // the button names no model: Auto
  }
  // → { ok, prev: the model it was on (to set back), why }
  async function pickModel(want) {
    if (!want) return null;
    const b = modelButton();
    if (!b) return { ok: false, prev: '', why: 'no model menu' };
    const now = modelNow(b);
    if (hasWord(now, want)) return { ok: true, prev: '' };                 // already on it
    const items = await openModelMenu(b);
    if (!items.length) return { ok: false, prev: '', why: 'the model menu did not open' };
    const cur = selectedItem(items, now), target = findItem(items, want);
    if (!target) { closeMenu(); return { ok: false, prev: '', why: `no "${want}" in the model menu` }; }
    const prev = cur && cur !== target ? itemName(cur) : '';
    target.click();
    if (!(await waitFor(() => !menuItems().length || null, 1500, 100))) closeMenu();
    return { ok: true, prev };
  }

  // Every top-level {...} span (string-aware), tried last-to-first, so the reply's
  // object is found even next to the prompt's pseudo-JSON schema or prose.
  function jsonSpans(text, open = '{', close = '}') {
    const spans = []; let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === open) { if (depth === 0) start = i; depth++; }
      else if (c === close && depth > 0) { depth--; if (depth === 0 && start >= 0) { spans.push([start, i + 1]); start = -1; } }
    }
    return spans;
  }
  const validResume = (o) => !!o && typeof o === 'object' && Array.isArray(o.work_history) && o.work_history.length > 0 && !!o.summary;
  function parseResume(raw) {
    const s = String(raw || '').replace(/```(?:json)?/gi, '');
    for (const [a, b] of jsonSpans(s).reverse()) { try { const o = JSON.parse(s.slice(a, b)); if (validResume(o)) return o; } catch { /* next span */ } }
    return null;
  }
  function extractJson(el, text) {
    if (el) for (const code of Array.from(el.querySelectorAll('pre code, pre')).reverse()) { const o = parseResume(textOf(code)); if (o) return o; }
    return parseResume(text) || parseResume(textOf(document.querySelector('main') || document.body));
  }
  function diagnose() {
    const r = lastReply(), c = q(SEL.composer);
    return { url: location.href, stop: !!q(SEL.stop), composer: !!c, composerUsable: composerUsable(), laidOut: !!c && c.getClientRects().length > 0,
      login: !!q(SEL.login), visibility: document.visibilityState, replyChars: r.text.length, jsonFound: !!extractJson(r.el, r.text), tail: r.text.slice(-120) };
  }
  const blockedResult = (k) => ({ ok: false, kind: k, error: k === 'needs_login' ? 'ChatGPT is not signed in.' : 'ChatGPT is rate-limited right now.', diag: diagnose() });
  async function composerOrFail() {
    const c = await waitFor(() => { const x = q(SEL.composer); return x && visible(x) ? x : null; }, 30_000, 500);
    return c;
  }

  async function generate({ prompt, timeoutMs = 6 * 60_000, model = '' }) {
    const b0 = detectBlocker(); if (b0) return blockedResult(b0);
    const composer = await composerOrFail();
    if (!composer) return { ok: false, kind: detectBlocker() || 'no_composer', error: 'Could not find the ChatGPT message box.', diag: diagnose() };
    if (model) await pickModel(model);                       // a pinned CV model (⚙ Settings)
    const baseline = lastReply();
    if (!(await typePrompt(composer, prompt))) return { ok: false, kind: 'no_composer', error: 'Could not type the prompt into ChatGPT.', diag: diagnose() };
    await clickSend(composer);
    const salvage = () => { const r = lastReply(); return extractJson(r.el, r.text); };
    const isResume = (r) => !!extractJson(r.el, r.text);
    let reply = await waitForReply(baseline, timeoutMs, isResume);
    if (reply.kind === 'timeout') { const j = salvage(); if (j) return { ok: true, resume_json: j, conversation: location.href, note: 'captured at timeout' }; }
    if (reply.kind) return { ok: false, kind: reply.kind, error: `ChatGPT did not finish (${reply.kind}).`, diag: diagnose() };
    let json = salvage();
    if (!json) {
      const c2 = q(SEL.composer); if (!c2) return { ok: false, kind: 'invalid_json', error: 'The reply was not valid JSON.', diag: diagnose() };
      const base2 = lastReply();
      await typePrompt(c2, 'Your previous reply was not valid JSON. Reply with ONLY the complete JSON object described above — no markdown fences, no commentary, no truncation.');
      await clickSend(c2);
      reply = await waitForReply(base2, Math.min(timeoutMs, 4 * 60_000), isResume);
      json = salvage();
      if (!json) return { ok: false, kind: reply.kind || 'invalid_json', error: 'ChatGPT replied, but not with a valid resume JSON object.', diag: diagnose() };
    }
    return { ok: true, resume_json: json, conversation: location.href };
  }

  // ---- answers: a JSON array of `count` strings
  function parseAnswers(raw, count) {
    const s = String(raw || '').replace(/```(?:json)?/gi, '');
    for (const [a, b] of jsonSpans(s, '[', ']').reverse()) {
      try {
        const arr = JSON.parse(s.slice(a, b));
        if (Array.isArray(arr) && arr.length === count && arr.every((x) => typeof x === 'string' && x.trim())) return arr;
      } catch { /* next span */ }
    }
    return null;
  }
  async function send(prompt, timeoutMs, ready) {
    const b0 = detectBlocker(); if (b0) return blockedResult(b0);
    const composer = await composerOrFail();
    if (!composer) return { ok: false, kind: detectBlocker() || 'no_composer', error: 'Could not find the ChatGPT message box.', diag: diagnose() };
    const baseline = lastReply();
    if (!(await typePrompt(composer, prompt))) return { ok: false, kind: 'no_composer', error: 'Could not type into ChatGPT.', diag: diagnose() };
    await clickSend(composer);
    const reply = await waitForReply(baseline, timeoutMs, ready);
    return reply.kind && reply.kind !== 'timeout' ? { ok: false, kind: reply.kind, error: `ChatGPT did not finish (${reply.kind}).`, diag: diagnose() } : { ok: true };
  }
  async function answers({ prompt, count, timeoutMs = 3 * 60_000, model = '' }) {
    if (!detectBlocker()) await composerOrFail();          // the page (and its model menu) is there
    const sel = model ? await pickModel(model) : null;    // a fast model for tech questions (⚙ Settings)
    try {
      const parsed = (l) => parseAnswers(l.el ? textOf(l.el) : l.text, count) || parseAnswers(l.text, count);
      const isAnswers = (l) => !!parsed(l);       // the list is complete: reported the moment ChatGPT stops
      let r = await send(prompt, timeoutMs, isAnswers);
      if (!r.ok) return r;
      const read = () => parsed(lastReply());
      let out = read();
      if (!out) {   // once more, strictly
        r = await send(`Reply with ONLY the JSON array of ${count} strings, one answer per question, in order. No other text.`, timeoutMs, isAnswers);
        if (!r.ok) return r;
        out = read();
      }
      return out ? { ok: true, answers: out, conversation: location.href, model: sel?.ok ? model : '' }
        : { ok: false, kind: 'invalid_json', error: 'ChatGPT did not return the answers as a list.', diag: diagnose() };
    } finally {
      if (sel?.prev) await pickModel(sel.prev).catch(() => {});   // back to the model the CVs are written with
    }
  }

  async function write(task) {
    const res = await generate(task);
    if (!res.ok || !task.answersPrompt) return res;
    const a = await answers({ prompt: task.answersPrompt, count: task.answersCount, timeoutMs: Math.min(task.timeoutMs || 360_000, 180_000), model: task.answersModel || '' });
    return a.ok ? { ...res, answers: a.answers, conversation: a.conversation || res.conversation } : { ...res, answersError: a.error || a.kind };
  }

  // ---- the signed-in account: its session token and its plan, from ChatGPT's own web API
  async function session() {
    try { return await (await fetch(`${location.origin}/api/auth/session`, { credentials: 'include' })).json(); } catch { return null; }
  }
  // The plan of the workspace ChatGPT is using now: the "_account" cookie picks it (a Team
  // member also has a free personal one), else the first in ChatGPT's own order.
  async function accountPlan() {
    const s = await session();
    const token = s?.accessToken;
    if (!token) return { kind: 'needs_login' };
    let plan = '', active = null;
    try {
      const r = await fetch(`${location.origin}/backend-api/accounts/check/v4-2023-04-27`, { credentials: 'include', headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const j = await r.json(), accounts = j.accounts || {};
        const chosen = decodeURIComponent((document.cookie.match(/(?:^|;\s*)_account=([^;]+)/) || [])[1] || '');
        const id = accounts[chosen] ? chosen : ((j.account_ordering || []).find((x) => accounts[x]) || Object.keys(accounts)[0]);
        const a = accounts[id] || {};
        plan = String(a.account?.plan_type || '').toLowerCase();
        if (typeof a.entitlement?.has_active_subscription === 'boolean') active = a.entitlement.has_active_subscription;
      }
    } catch { /* below: the session's own copy */ }
    if (!plan) plan = String(s.account?.planType || s.account?.plan_type || '').toLowerCase();
    return { plan, active };
  }
  const isFreePlan = (plan) => /^free/.test(plan);   // "free", "free_workspace"
  let paidUntil = 0, paidPlan = '';
  async function requirePaidPlan() {
    if (Date.now() < paidUntil) return { ok: true, plan: paidPlan };   // checked in this page a moment ago
    const res = await checkPaidPlan();
    if (res.ok) { paidUntil = Date.now() + 10 * 60_000; paidPlan = res.plan; }
    return res;
  }
  async function checkPaidPlan() {
    const p = await accountPlan();
    if (p.kind) return { ok: false, kind: 'needs_login', error: 'ChatGPT is not signed in.' };
    if (!p.plan && p.active == null) return { ok: false, kind: 'plan_unknown', error: 'Could not confirm which ChatGPT plan this account is on.' };
    if (isFreePlan(p.plan) || p.active === false) {
      return { ok: false, kind: 'free_plan', plan: p.plan || 'free', error: 'This ChatGPT account is on the Free plan — a paid plan (Plus, Pro, Team or Enterprise) is required.' };
    }
    return { ok: true, plan: p.plan || 'paid' };
  }

  // ---- delete conversations: what ChatGPT's own "Delete chat" does (hide it via its web API).
  async function deleteConversations({ ids = [] }) {
    const base = location.origin;
    const token = (await session())?.accessToken || '';
    if (!token) return { ok: false, kind: 'needs_login', error: 'ChatGPT is not signed in.' };
    const done = [], failed = [];
    for (const id of ids) {
      let r = null;
      try {
        r = await fetch(`${base}/backend-api/conversation/${encodeURIComponent(id)}`, {
          method: 'PATCH', credentials: 'include',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ is_visible: false }),
        });
      } catch { /* network */ }
      (r && (r.ok || r.status === 404) ? done : failed).push(id);   // 404: already gone
    }
    return { ok: true, done, failed };
  }

  const openConversation = () => (/\/c\/[\w-]{8,}/.test(location.pathname) ? location.href.split('#')[0] : '');
  async function work(task) {
    if (task.kind === 'delete') return deleteConversations(task);
    // Everything else writes with ChatGPT: a paid plan only.
    const paid = await requirePaidPlan();
    if (!paid.ok || task.kind === 'check') return paid;
    if (task.kind === 'answers') return { ...(await answers(task)), plan: paid.plan };
    return { ...(await write(task)), plan: paid.plan };
  }
  async function run(task) {
    let res;
    try { res = await work(task); } catch (e) { res = { ok: false, kind: 'error', error: String(e?.message || e) }; }
    // Failed or not, the conversation this frame opened is named — so it is deleted, never left behind.
    if (task.kind === 'write' || task.kind === 'answers') res.conversation = res.conversation || openConversation();
    return res;
  }

  // Ask for this tab's task, do it, report. (Pull: a fresh message wakes a suspended worker.)
  // The worker keeps ONE ChatGPT tab and gives it the next task: answers for the chat it is on are
  // started with a poke (gpt_poke) — no page load; anything else loads the page again.
  let pulling = false;
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type !== 'gpt_poke') return;
    reply({ ok: !pulling });
    if (!pulling) pull();
  });
  pull();
  async function pull() {
    if (pulling) return;
    pulling = true;
    try { await pullOnce(); } finally { pulling = false; }
  }
  async function pullOnce() {
    let task = null;
    for (let i = 0; i < 15 && !task; i++) {
      const r = await chrome.runtime.sendMessage({ type: 'gpt_ready' }).catch(() => null);
      if (r && r.ours === false) return;          // the bidder's own ChatGPT tab: nothing to do here
      task = r?.task || null;
      if (!task) await sleep(400);                // just opened: the worker is still recording its task
    }
    if (!task) return;
    FRAME = task.id;
    const beat = (conversation = openConversation()) => chrome.runtime.sendMessage({ type: 'gpt_alive', frame: FRAME, conversation }).catch(() => {});
    const alive = setInterval(beat, 20_000);
    // ChatGPT opens the conversation (/c/<id>) right after the prompt is sent: report it at once.
    let told = '';
    const watch = setInterval(() => { const c = openConversation(); if (c && c !== told) { told = c; beat(c); } }, 1000);
    const result = await run(task);
    clearInterval(alive); clearInterval(watch);
    for (let i = 0; i < 3; i++) {
      const ok = await chrome.runtime.sendMessage({ type: 'gpt_done', frame: FRAME, result }).then(() => true).catch(() => false);
      if (ok) break;
      await sleep(1000);
    }
  }
})();
