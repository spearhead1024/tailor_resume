/* chatgpt.com driver — runs inside the HIDDEN ChatGPT frames of the extension's offscreen
 * document (gpt/offscreen.js); registered as a content script for chatgpt.com once ChatGPT
 * is connected. In the user's own ChatGPT tabs it does nothing.
 *
 * A frame is named "trgpt-<work id>". On load the driver asks the service worker for that
 * frame's task (gpt_ready → task), does it, and reports back (gpt_done) — a fresh message,
 * so a service worker suspended meanwhile wakes up for it. While working it sends a
 * heartbeat (gpt_alive), which also keeps the service worker running.
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
  const FRAME = String(window.name || '');
  if (window.top === window || !FRAME.startsWith('trgpt-') || window.__trGptDriver) return;   // not our hidden frame
  window.__trGptDriver = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sels, root = document) => { for (const s of sels) { try { const el = root.querySelector(s); if (el) return el; } catch { /* bad selector */ } } return null; };
  // This page lives in a hidden frame that may never be laid out or painted: "visible" and
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
  async function waitFor(fn, ms, step = 500) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); } return null; }

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
    await sleep(200);
    const typed = () => textOf(composer).trim().length >= Math.min(prompt.length, 200) * 0.8;
    if (!ok || !typed()) {
      try {
        const dt = new DataTransfer(); dt.setData('text/plain', prompt);
        composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await sleep(300);
      } catch { /* no DataTransfer — fall through */ }
      if (!typed()) { try { composer.textContent = prompt; composer.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200); } catch { /* */ } }
      ok = typed();
    }
    return ok;
  }
  async function clickSend(composer) {
    const btn = await waitFor(() => { const b = q(SEL.send); return b && !b.disabled && visible(b) ? b : null; }, 8000, 250);
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

  // Done = the reply changed from the pre-send snapshot, is no longer streaming (no
  // stop button) and its text has been stable for a few ticks.
  async function waitForReply(baseline, timeoutMs) {
    const end = Date.now() + timeoutMs;
    let last = '', stable = 0;
    const started = await waitFor(() => { const r = lastReply(); return (r.count > baseline.count || r.text !== baseline.text) || q(SEL.stop); }, 60_000, 500);
    if (!started && limitTextPresent()) return { kind: 'rate_limited' };
    while (Date.now() < end) {
      if (detectBlocker() === 'needs_login') return { kind: 'needs_login' };
      const r = lastReply();
      const changed = r.count > baseline.count || r.text !== baseline.text;
      if (changed && !q(SEL.stop) && r.text) { stable = r.text === last ? stable + 1 : 0; last = r.text; if (stable >= 3) return { done: true }; }
      else { stable = 0; last = r.text; }
      await sleep(700);
    }
    return { kind: 'timeout' };
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

  async function generate({ prompt, timeoutMs = 6 * 60_000 }) {
    const b0 = detectBlocker(); if (b0) return blockedResult(b0);
    const composer = await composerOrFail();
    if (!composer) return { ok: false, kind: detectBlocker() || 'no_composer', error: 'Could not find the ChatGPT message box.', diag: diagnose() };
    const baseline = lastReply();
    if (!(await typePrompt(composer, prompt))) return { ok: false, kind: 'no_composer', error: 'Could not type the prompt into ChatGPT.', diag: diagnose() };
    await sleep(300); await clickSend(composer);
    const salvage = () => { const r = lastReply(); return extractJson(r.el, r.text); };
    let reply = await waitForReply(baseline, timeoutMs);
    if (reply.kind === 'timeout') { const j = salvage(); if (j) return { ok: true, resume_json: j, conversation: location.href, note: 'captured at timeout' }; }
    if (reply.kind) return { ok: false, kind: reply.kind, error: `ChatGPT did not finish (${reply.kind}).`, diag: diagnose() };
    let json = salvage();
    if (!json) {
      const c2 = q(SEL.composer); if (!c2) return { ok: false, kind: 'invalid_json', error: 'The reply was not valid JSON.', diag: diagnose() };
      const base2 = lastReply();
      await typePrompt(c2, 'Your previous reply was not valid JSON. Reply with ONLY the complete JSON object described above — no markdown fences, no commentary, no truncation.');
      await sleep(300); await clickSend(c2);
      reply = await waitForReply(base2, Math.min(timeoutMs, 4 * 60_000));
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
  async function send(prompt, timeoutMs) {
    const b0 = detectBlocker(); if (b0) return blockedResult(b0);
    const composer = await composerOrFail();
    if (!composer) return { ok: false, kind: detectBlocker() || 'no_composer', error: 'Could not find the ChatGPT message box.', diag: diagnose() };
    const baseline = lastReply();
    if (!(await typePrompt(composer, prompt))) return { ok: false, kind: 'no_composer', error: 'Could not type into ChatGPT.', diag: diagnose() };
    await sleep(300); await clickSend(composer);
    const reply = await waitForReply(baseline, timeoutMs);
    return reply.kind && reply.kind !== 'timeout' ? { ok: false, kind: reply.kind, error: `ChatGPT did not finish (${reply.kind}).`, diag: diagnose() } : { ok: true };
  }
  async function answers({ prompt, count, timeoutMs = 3 * 60_000 }) {
    let r = await send(prompt, timeoutMs);
    if (!r.ok) return r;
    const read = () => { const l = lastReply(); return parseAnswers(l.el ? textOf(l.el) : l.text, count) || parseAnswers(l.text, count); };
    let out = read();
    if (!out) {   // once more, strictly
      r = await send(`Reply with ONLY the JSON array of ${count} strings, one answer per question, in order. No other text.`, timeoutMs);
      if (!r.ok) return r;
      out = read();
    }
    return out ? { ok: true, answers: out, conversation: location.href } : { ok: false, kind: 'invalid_json', error: 'ChatGPT did not return the answers as a list.', diag: diagnose() };
  }

  async function write(task) {
    const res = await generate(task);
    if (!res.ok || !task.answersPrompt) return res;
    const a = await answers({ prompt: task.answersPrompt, count: task.answersCount, timeoutMs: Math.min(task.timeoutMs || 360_000, 180_000) });
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
  async function requirePaidPlan() {
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

  async function run(task) {
    try {
      if (task.kind === 'delete') return await deleteConversations(task);
      // Everything else writes with ChatGPT: a paid plan only.
      const paid = await requirePaidPlan();
      if (!paid.ok || task.kind === 'check') return paid;
      if (task.kind === 'answers') return { ...(await answers(task)), plan: paid.plan };
      return { ...(await write(task)), plan: paid.plan };
    } catch (e) { return { ok: false, kind: 'error', error: String(e?.message || e) }; }
  }

  // Ask for this frame's task, do it, report. (Pull — a hidden frame has no tab id to send to.)
  (async () => {
    let task = null;
    for (let i = 0; i < 5 && !task; i++) {
      task = await chrome.runtime.sendMessage({ type: 'gpt_ready', frame: FRAME }).then((r) => r?.task || null).catch(() => null);
      if (!task) await sleep(1500);
    }
    if (!task) return;
    const alive = setInterval(() => chrome.runtime.sendMessage({ type: 'gpt_alive', frame: FRAME }).catch(() => {}), 20_000);
    const result = await run(task);
    clearInterval(alive);
    for (let i = 0; i < 3; i++) {
      const ok = await chrome.runtime.sendMessage({ type: 'gpt_done', frame: FRAME, result }).then(() => true).catch(() => false);
      if (ok) break;
      await sleep(1000);
    }
  })();
})();
