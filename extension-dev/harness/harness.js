/* Dev harness: plays "the browser" for the extension (see chrome-shim.js): the side
 * panel (#panelFrame) and the background worker (a hidden frame running background.js).
 * - tabs: a tab strip of same-origin iframes. A tab's url is the REAL url the panel sees
 *   (e.g. https://boards.greenhouse.io/…); its iframe shows a sample page (pages/) or the
 *   real page fetched through /proxy, so chrome.scripting can run code in it.
 * - storage: chrome.storage.local → localStorage, .session → sessionStorage (this tab).
 * - messages: runtime.sendMessage between panel, worker and content scripts in tabs;
 *   tabs.sendMessage to content scripts. Alarms run as timers.
 * - chatgpt.com tabs show pages/chatgpt.html, a stand-in with the same composer, send /
 *   stop buttons and a streamed reply — so the GPT helper's real driver runs against it.
 * - the Autofill shortcut Alt+Shift+F goes to the worker, like Chrome's commands.
 * - Dry run: API writes are answered here instead of reaching the server. */
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const START_URL = 'harness://start';
const SAMPLES = [
  { label: 'Greenhouse posting (JSON-LD)', url: 'https://boards.greenhouse.io/northwindlabs/jobs/4012345', file: 'greenhouse.html' },
  { label: 'Lever posting (page only)', url: 'https://jobs.lever.co/contoso/7c1e5a2b-3d4f-4e6a-9b8c-1d2e3f4a5b6c', file: 'lever.html' },
  { label: 'LinkedIn job view', url: 'https://www.linkedin.com/jobs/view/4123456789', file: 'linkedin.html' },
  { label: 'Company careers page (generic)', url: 'https://careers.fabrikam.example/jobs/platform-engineer', file: 'generic.html' },
  { label: 'Application form (for Autofill)', url: 'https://boards.greenhouse.io/northwindlabs/jobs/4012345/apply', file: 'apply-form.html' },
];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---------- events into the panel ----------
const L = {};
const bucket = (b) => (L[b] ||= []);
let panelWin = null, bgWin = null;
const live = (win) => win === panelWin || win === bgWin;   // listeners of a reloaded page are gone, like in Chrome
function emit(b, ...args) {
  for (const { win, fn } of bucket(b).slice()) {
    if (!live(win)) continue;
    setTimeout(() => { try { fn(...args); } catch (e) { console.error(`[harness] ${b} listener`, e); } }, 0);
  }
}

// ---------- chrome.storage ----------
const AREA = { local: [localStorage, 'extdev.local'], session: [sessionStorage, 'extdev.session'] };
const load = (a) => { try { return JSON.parse(AREA[a][0].getItem(AREA[a][1]) || '{}'); } catch { return {}; } };
const save = (a, all) => AREA[a][0].setItem(AREA[a][1], JSON.stringify(all));
const store = {
  async get(a, keys) {
    const all = load(a);
    if (keys == null) return clone(all);
    if (typeof keys === 'string') keys = [keys];
    const out = {};
    if (Array.isArray(keys)) { for (const k of keys) if (k in all) out[k] = clone(all[k]); return out; }
    for (const [k, d] of Object.entries(keys)) out[k] = k in all ? clone(all[k]) : d;
    return out;
  },
  async set(a, obj) {
    const all = load(a); const changes = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const nv = clone(v);
      if (JSON.stringify(all[k]) !== JSON.stringify(nv)) changes[k] = { oldValue: all[k], newValue: nv };
      all[k] = nv;
    }
    save(a, all);
    if (Object.keys(changes).length) emit('storage', changes, a);
  },
  async remove(a, keys) {
    const all = load(a); const changes = {};
    for (const k of typeof keys === 'string' ? [keys] : keys || []) if (k in all) { changes[k] = { oldValue: all[k] }; delete all[k]; }
    save(a, all);
    if (Object.keys(changes).length) emit('storage', changes, a);
  },
  async clear(a) { const all = load(a); save(a, {}); const ch = {}; for (const k of Object.keys(all)) ch[k] = { oldValue: all[k] }; if (Object.keys(ch).length) emit('storage', ch, a); },
};

// ---------- tabs ----------
let nextTabId = 101;
const tabs = [];
let activeId = null;
const tabById = (id) => tabs.find((t) => t.id === id) || null;
const info = (t) => ({ id: t.id, windowId: 1, index: tabs.indexOf(t), active: t.id === activeId, url: t.url, title: t.title, status: t.status });
const isWeb = (url) => /^https?:\/\//i.test(url);

function srcFor(url) {
  if (url === START_URL) return '/harness/start.html';
  const s = SAMPLES.find((x) => x.url === url);
  if (s) return `/pages/${s.file}`;
  if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) return `/pages/chatgpt.html?u=${encodeURIComponent(url)}`;
  if (isWeb(url)) return `/proxy?url=${encodeURIComponent(url)}`;
  return null;
}

function newTab(url, { active = true } = {}) {
  const frame = document.createElement('iframe');
  frame.className = 'bgtab';   // background tabs keep their layout (like Chrome), just not shown
  $('#frames').appendChild(frame);
  const t = { id: nextTabId++, url: '', title: '', status: 'loading', frame, ready: null, cs: [] };
  frame.addEventListener('load', () => onFrameLoad(t));
  tabs.push(t);
  navigate(t, url);
  if (active) activate(t);
  renderTabs();
  return t;
}

function navigate(t, url) {
  t.cs = [];   // a new document: its content scripts are gone
  t.url = url; t.title = url; t.status = 'loading';
  t.ready = new Promise((r) => { t.markReady = r; });
  const src = srcFor(url);
  if (src) { t.frame.removeAttribute('srcdoc'); t.frame.src = src; }
  else if (/^chrome:\/\/newtab\/?$/.test(url)) {
    t.frame.removeAttribute('src');
    t.frame.srcdoc = '<title>New Tab</title><body style="margin:0;background:#fff"></body>';
  } else {
    t.frame.removeAttribute('src');
    t.frame.srcdoc = `<body style="font:14px system-ui;padding:24px;color:#444"><h3>${esc(url)}</h3><p>Browser pages can't be shown in the dev harness. In the real browser this opens normally.</p></body>`;
  }
  emit('tabUpdated', t.id, { status: 'loading', url }, info(t));
  if (t.id === activeId) $('#url').value = url === START_URL ? '' : url;
  renderTabs();
}

function onFrameLoad(t) {
  t.status = 'complete'; t.cs = [];
  try {
    const doc = t.frame.contentDocument;
    t.title = doc.title || t.url;
    hookPage(t, t.frame.contentWindow);
  } catch { /* cross-origin — never happens for our sources */ }
  t.markReady?.();
  emit('tabUpdated', t.id, { status: 'complete', title: t.title }, info(t));
  renderTabs();
}

// Links in a page navigate the TAB (through srcFor), so the panel sees real URLs.
function hookPage(t, win) {
  hookKeys(win);
  win.document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]'); if (!a) return;
    const href = a.getAttribute('data-url') || a.href;
    if (!isWeb(href) && !href.startsWith('harness://')) return;
    e.preventDefault();
    if (a.target === '_blank' || e.ctrlKey || e.metaKey) newTab(href); else navigate(t, href);
  });
  win.document.addEventListener('submit', (e) => {
    e.preventDefault();
    const b = win.document.createElement('div');
    b.textContent = 'Form submit stopped by the dev harness (nothing was sent).';
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;background:#111;color:#fff;padding:8px 12px;border-radius:8px;font:13px system-ui;z-index:99999';
    win.document.body.appendChild(b); setTimeout(() => b.remove(), 3000);
  }, true);
}

function activate(t) {
  if (!t) return;
  activeId = t.id;
  for (const x of tabs) x.frame.classList.toggle('bgtab', x !== t);
  $('#url').value = t.url === START_URL ? '' : t.url;
  emit('tabActivated', { tabId: t.id, windowId: 1 });
  renderTabs();
}

function closeTab(t) {
  const i = tabs.indexOf(t); if (i < 0) return;
  tabs.splice(i, 1); t.frame.remove();
  emit('tabRemoved', t.id, { windowId: 1, isWindowClosing: false });
  if (t.id === activeId) activate(tabs[Math.min(i, tabs.length - 1)] || newTab(START_URL));
  renderTabs();
}

function renderTabs() {
  $('#tabstrip').innerHTML = tabs.map((t) => `
    <div class="tab ${t.id === activeId ? 'active' : ''}" data-tab="${t.id}" title="${esc(t.url)}">
      <span class="t">${t.status === 'loading' ? '⏳ ' : ''}${esc(t.title || t.url)}</span>
      <button class="x" data-close="${t.id}" title="Close tab">×</button>
    </div>`).join('') + '<div class="tab new" data-newtab="1" title="New tab">+</div>';
}
$('#tabstrip').addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]'); if (c) { closeTab(tabById(Number(c.dataset.close))); return; }
  if (e.target.closest('[data-newtab]')) { newTab(START_URL); return; }
  const t = e.target.closest('[data-tab]'); if (t) activate(tabById(Number(t.dataset.tab)));
});

const tabsApi = {
  async query(q) { return tabs.filter((t) => !q.active || t.id === activeId).map(info); },
  async get(id) { const t = tabById(id); if (!t) throw new Error(`No tab with id: ${id}.`); return info(t); },
  async create({ url = 'chrome://newtab/', active = true } = {}) { return info(newTab(url, { active })); },
  async update(id, { url, active } = {}) {
    const t = id == null ? tabById(activeId) : tabById(id);
    if (!t) throw new Error(`No tab with id: ${id}.`);
    if (url) navigate(t, url);
    if (active) activate(t);
    return info(t);
  },
  async remove(id) { for (const x of [].concat(id)) closeTab(tabById(x)); },
};

// ---------- chrome.scripting.executeScript ----------
// Frame 0 runs with `location` = the tab's real URL and window.top === window (as in a
// real tab); same-origin child frames are frameIds 1…n.
function topProxy(win) {
  const P = new Proxy(win, {
    get(t, k) {
      if (k === 'top' || k === 'parent' || k === 'window' || k === 'self') return P;
      const v = Reflect.get(t, k);
      return typeof v === 'function' && typeof k === 'string' && /^[a-z]/.test(k) ? v.bind(t) : v;
    },
    set: (t, k, v) => Reflect.set(t, k, v),
  });
  return P;
}
function framesOf(t) {
  const out = [{ frameId: 0, win: t.frame.contentWindow }];
  const walk = (w) => {
    for (let i = 0; i < w.frames.length; i++) {
      const f = w.frames[i];
      try { void f.document; out.push({ frameId: out.length, win: f }); walk(f); } catch { /* cross-origin frame: Chrome would need host access too */ }
    }
  };
  walk(t.frame.contentWindow);
  return out;
}
const fileCache = {};
// `location` for code run in a tab: always the tab's CURRENT url (pushState included).
function liveLocation(t) {
  return new Proxy({}, { get: (_o, k) => { const u = new URL(t.url); return k === 'toString' || k === Symbol.toPrimitive ? () => u.href : u[k]; } });
}
// What a content script sees as `chrome`: messages only, like the real thing.
function contentChrome(t, frameId) {
  return {
    runtime: {
      id: 'dev-harness',
      sendMessage: (msg) => sendMessage(msg, null, { id: 'dev-harness', tab: info(t), frameId, url: t.url }),
      onMessage: { addListener: (fn) => t.cs.push(fn), removeListener: (fn) => { t.cs = t.cs.filter((x) => x !== fn); } },
    },
  };
}
// chrome.tabs.sendMessage → the tab's content scripts.
async function tabMessage(tabId, msg) {
  const t = tabById(tabId);
  if (!t) throw new Error(`No tab with id: ${tabId}.`);
  if (!t.cs.length) throw new Error('Could not establish connection. Receiving end does not exist.');
  return deliver(t.cs.slice(), msg, { id: 'dev-harness' });
}
// Call message listeners like Chrome: the first sendResponse wins; `return true` keeps the channel open.
function deliver(fns, msg, sender) {
  return new Promise((resolve) => {
    let done = false, waiting = false;
    const respond = (v) => { if (!done) { done = true; resolve(clone(v)); } };
    for (const fn of fns) {
      try { if (fn(clone(msg), sender, respond) === true) waiting = true; } catch (e) { console.error('[harness] onMessage listener', e); }
    }
    if (!waiting) setTimeout(() => respond(undefined), 0);
  });
}
// chrome.runtime.sendMessage → every extension page except the sender.
async function sendMessage(msg, fromWin, sender) {
  const fns = bucket('message').filter((x) => live(x.win) && x.win !== fromWin).map((x) => x.fn);
  if (!fns.length) throw new Error('Could not establish connection. Receiving end does not exist.');
  return deliver(fns, msg, sender);
}
// The ChatGPT stand-in moved to /c/<id> (history.pushState in the real app).
function pushUrl(win, url) {
  const t = tabs.find((x) => x.frame.contentWindow === win); if (!t) return;
  t.url = url;
  emit('tabUpdated', t.id, { url }, info(t));
  if (t.id === activeId) $('#url').value = url;
  renderTabs();
}
// chrome.alarms as timers.
const alarms = {};
function alarmCreate(name, { periodInMinutes = 0, delayInMinutes = 0 } = {}) {
  clearInterval(alarms[name]?.timer);
  const ms = Math.max(0.5, periodInMinutes || delayInMinutes || 0.5) * 60_000;
  alarms[name] = { name, periodInMinutes, timer: setInterval(() => emit('alarm', { name, scheduledTime: Date.now() }), ms) };
}
const alarmGet = (name) => (alarms[name] ? { name, periodInMinutes: alarms[name].periodInMinutes } : undefined);
const alarmClear = (name) => { const had = !!alarms[name]; clearInterval(alarms[name]?.timer); delete alarms[name]; return had; };
async function executeScript({ target = {}, func, args = [], files }) {
  const t = tabById(target.tabId);
  if (!t) throw new Error(`No tab with id: ${target.tabId}.`);
  if (!srcFor(t.url) || t.url === START_URL) throw new Error(`Cannot access contents of url "${t.url}". Extension manifest must request permission to access this host.`);
  await Promise.race([t.ready, new Promise((r) => setTimeout(r, 15000))]);
  let frames = framesOf(t);
  if (target.frameIds) frames = frames.filter((f) => target.frameIds.includes(f.frameId));
  else if (!target.allFrames) frames = frames.slice(0, 1);
  const out = [];
  for (const f of frames) {
    const win = f.frameId === 0 ? topProxy(f.win) : f.win;
    const loc = f.frameId === 0 && isWeb(t.url) ? liveLocation(t) : f.win.location;
    let result;
    if (files) {
      for (const file of files) {
        const code = fileCache[file] ??= await (await fetch(`/ext/${file}`, { cache: 'no-store' })).text();
        f.win.Function('location', 'window', 'top', 'chrome', code)(loc, win, win, contentChrome(t, f.frameId));
      }
    } else {
      const fn = f.win.Function('location', 'window', 'top', `return (${func.toString()})`)(loc, win, win);
      result = await fn(...clone(args || []));
    }
    out.push({ frameId: f.frameId, documentId: `doc-${t.id}-${f.frameId}`, result: clone(result) });
  }
  return out;
}

// ---------- misc chrome.* ----------
let dlId = 1;
async function download(opts, win) {
  const a = win.document.createElement('a');
  a.href = opts.url; a.download = opts.filename || ''; win.document.body.appendChild(a); a.click(); a.remove();
  const id = dlId++;
  setTimeout(() => emit('download', { id, state: { previous: 'in_progress', current: 'complete' } }), 300);
  return id;
}

// The Autofill shortcut, as background.js does it.
function hookKeys(win) {
  win.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyF') { e.preventDefault(); autofillCommand(); }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyR') { e.preventDefault(); reloadPanel(); }
  }, true);
}
function autofillCommand() {
  emit('command', 'autofill', info(tabById(activeId)));   // background.js handles it, as in Chrome
}

// ---------- dry run + request log ----------
// What dry-run writes "saved", so the next reads show them (in this page only, until reload).
const dryStore = { answers: {}, questions: {} };
function dryRunAnswer(method, path, body) {
  if (!$('#dry').checked) return null;
  const parse = () => { try { return JSON.parse(body || '{}'); } catch { return {}; } };
  const rid = (path.match(/^\/api\/resumes\/([^/]+)\/(?:pdf|answers)$/) || [])[1] || '';
  if (method === 'GET') {
    if (/^resume_dry_/.test(rid) && path.endsWith('/pdf')) return { status: 200, note: 'sample PDF (dry run)', file: '/harness/sample-cv.pdf' };
    if (rid && path.endsWith('/answers') && (dryStore.answers[rid] || /^resume_dry_/.test(rid))) return { status: 200, note: 'dry-run answers', body: { answers: dryStore.answers[rid] || [] } };
    return null;   // every other read is real
  }
  // Read-only even though they are POSTs: your own sign-in, and the duplicate check.
  if (path === '/api/auth/login' || path === '/api/jobs/check-duplicate') return null;
  if (method === 'POST' && path === '/api/resumes/generate-from-json') {
    const id = `resume_dry_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    dryNotice('Dry run — the CV was NOT saved. A sample PDF stands in for it.');
    return { status: 200, note: 'CV build — not saved', body: { ok: true, saved_resume_id: id, ats_score: 87, ats: null } };
  }
  if (method === 'PUT' && rid && path.endsWith('/answers')) {
    dryStore.answers[rid] = (parse().answers || []).filter((a) => a?.question && a?.answer);
    return { status: 200, note: 'answers — not saved', body: { answers: dryStore.answers[rid] } };
  }
  const qJob = (path.match(/^\/api\/resumes\/bid-job\/([^/]+)\/questions$/) || [])[1];
  if (method === 'PUT' && qJob) {
    const raw = parse().questions;
    const lines = (typeof raw === 'string' ? raw.split('\n') : raw || []).map((q) => String(q).replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s*/, '').trim()).filter(Boolean);
    dryStore.questions[qJob] = [...new Set(lines)].slice(0, 15);
    dryNotice('Dry run — the questions were NOT saved for other bidders.');
    return { status: 200, note: 'questions — not saved', body: { questions: dryStore.questions[qJob] } };
  }
  if (method === 'POST' && path === '/api/jobs') {
    let p = {}; try { p = JSON.parse(body || '{}').payload || {}; } catch { /* */ }
    dryNotice('Dry run — this job was NOT saved, so it is not in the Jobs tab. Untick "Dry run" in the top bar to add jobs for real.');
    return { status: 200, note: 'Add job — not saved', body: { ...p, id: `job_dryrun_${Date.now().toString(36)}`, submitted_at: new Date().toISOString() } };
  }
  if (path === '/api/resumes/bid/track') return { status: 200, note: 'audit trail — not saved', body: { ok: true } };
  dryNotice(`Dry run — ${method} ${path} was not sent.`);
  return { status: 409, note: 'not sent', body: { detail: `Dry run: ${method} ${path} was not sent to the server. Untick "Dry run" in the harness bar to send it for real.` } };
}
// Real reads, adjusted by what a dry-run write "saved" (a job's questions).
function dryRunPatch(method, path, json) {
  if (method !== 'GET' || !json || !$('#dry').checked) return null;
  const job = (path.match(/^\/api\/resumes\/bid-job\/([^/]+)$/) || [])[1];
  return job && dryStore.questions[job] ? { ...json, questions: dryStore.questions[job] } : null;
}
// A dry-run write must never look like the real thing: say so over the panel.
function dryNotice(text) {
  const el = $('#dryNotice');
  el.textContent = text; el.hidden = false;
  clearTimeout(dryNotice.t); dryNotice.t = setTimeout(() => { el.hidden = true; }, 7000);
}
function log(e) {
  const row = document.createElement('div');
  row.className = `log-row${e.dry ? ' dry' : ''}${e.status >= 400 || e.status === 0 ? ' err' : ''}`;
  row.innerHTML = `<span class="muted">${new Date().toLocaleTimeString([], { hour12: false })}</span><span>${esc(e.method)}</span><span class="s">${e.dry ? 'DRY' : esc(e.status)}</span><span class="p" title="${esc(e.path)}">${esc(e.path)} <span class="muted">${e.note ? '· ' + esc(e.note) : ''}${e.ms ? ` · ${e.ms}ms` : ''}</span></span>`;
  const body = $('#logBody'); body.prepend(row);
  while (body.children.length > 300) body.lastChild.remove();
}

// ---------- the panel ----------
function attach(role, win) {
  if (role === 'bg') bgWin = win; else { panelWin = win; hookKeys(win); }
  for (const k of Object.keys(L)) L[k] = L[k].filter((x) => live(x.win));
}
// Reload the panel AND the worker, so edits anywhere in extension/ are picked up.
function reloadFrames() {
  for (const k of Object.keys(fileCache)) delete fileCache[k];   // content scripts are re-read too
  for (const k of Object.keys(alarms)) alarmClear(k);
  panelWin = null; bgWin = null;
  clearErrors();
  $('#bgFrame').src = `/harness/bg.html?t=${Date.now()}`;
  $('#panelFrame').src = `/ext/panel/panel.html?t=${Date.now()}`;
}
// "↻ Reload panel": if the harness's OWN files changed since this page loaded, a new panel
// on an old harness can't work — reload the whole page instead (Chrome would restart too).
const HARNESS_FILES = ['/harness/harness.js', '/harness/chrome-shim.js', '/harness/index.html', '/harness/harness.css', '/harness/bg.html'];
async function harnessFingerprint() {
  const texts = await Promise.all(HARNESS_FILES.map((f) => fetch(f, { cache: 'no-store' }).then((r) => r.text()).catch(() => '')));
  let h = 0; for (const ch of texts.join('\u0000')) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0;
  return h;
}
let loadedFingerprint = null;
harnessFingerprint().then((h) => { loadedFingerprint = h; });
async function reloadPanel() {
  if (loadedFingerprint !== null && (await harnessFingerprint()) !== loadedFingerprint) { location.reload(); return; }
  reloadFrames();
}

// ---------- errors in the panel / worker: shown, never a silent blank panel ----------
const errors = [];
function reportError(role, text) {
  const line = `${role === 'bg' ? 'Background worker' : 'Panel'}: ${text}`;
  if (errors.includes(line)) return;
  errors.push(line);
  const el = $('#panelErr');
  el.innerHTML = `<strong>The extension hit an error</strong><ul>${errors.slice(-5).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
    + '<div class="muted">Fix it, then ↻ Reload panel. Details are in the browser console.</div><button class="ghost sm" id="panelErrX">Dismiss</button>';
  el.hidden = false;
  $('#panelErrX').onclick = () => { el.hidden = true; };
  log({ method: 'ERR', path: line, status: 0 });
}
function clearErrors() { errors.length = 0; $('#panelErr').hidden = true; }
// A script that would not load: walk its imports and name the file that fails, and retry
// once — a file lost in transit (e.g. through a port forward) usually loads the next time.
let retried = false;
async function scriptFailed(role, src) {
  const path = (u) => u.replace(location.origin, '');
  const seen = new Set(), queue = [src], problems = [];
  while (queue.length) {
    const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
    let res, text;
    try { res = await fetch(url, { cache: 'no-store' }); text = await res.text(); }
    catch (e) { problems.push(`${path(url)}: could not be downloaded (${e.message})`); continue; }
    if (!res.ok) { problems.push(`${path(url)}: HTTP ${res.status}`); continue; }
    const type = res.headers.get('content-type') || '';
    if (!/javascript/.test(type)) problems.push(`${path(url)}: served as "${type}", not JavaScript`);
    const specs = /(?:^|[;\n])\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
    for (const m of text.matchAll(specs)) queue.push(new URL(m[1] || m[2], url).href);
  }
  if (problems.length) for (const p of problems) reportError(role, p);
  else if (!retried) { retried = true; reportError(role, `all ${seen.size} files download fine now — it was a hiccup in transit. Reloading…`); setTimeout(reloadFrames, 800); }
  else reportError(role, `all ${seen.size} files download fine from here, but your browser could not load them. Check the Ports forward for 8600 in VS Code, then press F5.`);
}
// The panel must render something within a few seconds (sign-in or the tabs).
$('#panelFrame').addEventListener('load', () => {
  const frame = $('#panelFrame'), src = frame.src;
  setTimeout(() => {
    if (frame.src !== src) return;   // reloaded meanwhile
    let empty = true;
    try { empty = !frame.contentDocument.querySelector('#app')?.childElementCount; } catch { /* */ }
    if (empty) reportError('panel', 'it did not start — nothing was rendered.');
  }, 6000);
});

window.__harness = {
  manifest: null,
  attach, reportError, scriptFailed,
  on: (b, win, fn) => { bucket(b).push({ win, fn }); },
  off: (b, fn) => { L[b] = bucket(b).filter((x) => x.fn !== fn); },
  has: (b, fn) => bucket(b).some((x) => x.fn === fn),
  store: {
    get: (a, k) => store.get(a, k), set: (a, o) => store.set(a, o),
    remove: (a, k) => store.remove(a, k), clear: (a) => store.clear(a),
  },
  tabs: tabsApi,
  executeScript, download, sendMessage, tabMessage, dryRunAnswer, dryRunPatch, log,
  alarmCreate, alarmGet, alarmClear, pushUrl,
};

// ---------- harness chrome ----------
// Dry run is ON every time the harness opens: going live (real writes to the database) is
// a deliberate choice for this visit only, never remembered.
function setDryNote() { $('#liveNote').hidden = $('#dry').checked; }
$('#dry').checked = true;
$('#dry').addEventListener('change', setDryNote);
try { localStorage.removeItem('extdev.dry'); } catch { /* an older harness remembered it */ }
setDryNote();
$('#reloadPanel').addEventListener('click', reloadPanel);
$('#resetStore').addEventListener('click', async () => {
  localStorage.removeItem(AREA.local[1]); sessionStorage.removeItem(AREA.session[1]);
  await store.set('local', { apiBase: location.origin });
  reloadFrames();
});
$('#toggleLog').addEventListener('click', () => { $('#log').hidden = !$('#log').hidden; });
$('#clearLog').addEventListener('click', () => { $('#logBody').innerHTML = ''; });
$('#samples').innerHTML += SAMPLES.map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join('');
$('#samples').addEventListener('change', (e) => {
  const s = SAMPLES[Number(e.target.value)]; e.target.value = '';
  if (s) navigate(tabById(activeId), s.url);
});
$('#addr').addEventListener('submit', (e) => {
  e.preventDefault();
  let u = $('#url').value.trim(); if (!u) return;
  if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
  navigate(tabById(activeId), u);
});

// Panel width: drag the handle (remembered).
(() => {
  const box = $('#panelBox'), split = document.querySelector('.split');
  const setW = (w) => { w = Math.max(260, Math.min(900, Math.round(w))); box.style.width = `${w}px`; $('#pw').textContent = `${w}px`; return w; };
  let w = 380; try { w = Number(localStorage.getItem('extdev.panelW')) || 380; } catch { /* */ }
  setW(w);
  $('#handle').addEventListener('pointerdown', (e) => {
    e.preventDefault(); split.classList.add('dragging'); $('#handle').classList.add('drag');
    const move = (ev) => { w = setW(window.innerWidth - ev.clientX - 3); };
    const up = () => { split.classList.remove('dragging'); $('#handle').classList.remove('drag'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); try { localStorage.setItem('extdev.panelW', String(w)); } catch { /* */ } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
})();

hookKeys(window);

(async function start() {
  try { window.__harness.manifest = await (await fetch('/ext/manifest.json', { cache: 'no-store' })).json(); } catch { /* */ }
  $('#ver').textContent = window.__harness.manifest ? `v${window.__harness.manifest.version} · dev harness` : 'dev harness';
  // The panel talks to the API through this server (same origin), not the live URL.
  await store.set('local', { apiBase: location.origin });
  const first = new URLSearchParams(location.search).get('url');
  newTab(first || START_URL);
  reloadFrames();
})();
