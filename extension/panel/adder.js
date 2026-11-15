/* "Add job" tab of the side panel — for job_adders (and admins).
 * - The current tab's URL is checked against TailorResume as soon as the tab is shown
 *   (same link / blacklist rules as saving), so a job that is already on file is
 *   flagged before anything is fetched.
 * - Fetch Job Details reads the posting (link, company, title, description — see
 *   extractor.js); the adder checks/corrects it and picks the region (remembered).
 * - Add & Next adds it through the same endpoint as the web Jobs tab's "Add job" form
 *   (so the server's duplicate rules and the blacklist apply unchanged), closes the
 *   job's tab and moves to the next tab — or a new empty tab when it was the last.
 * The same live duplicate check as the web form runs while the fields change.
 * Vanilla JS, no deps. Ids are prefixed "ad" — the Bid view lives in the same page. */

import { extractJobFromPage } from './extractor.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (body) => `<svg viewBox="0 0 24 24">${body}</svg>`;
const I = {
  fetch: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  next: svg('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
  eraser: svg('<path d="M20 20H7L3 16a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-7 7"/>'),
};

// The markets jobs and profiles are matched on (storage._ALLOWED_REGIONS). ANY = open to all.
const REGIONS = ['US', 'EU', 'LATAM', 'ANY'];
const REGION_LABEL = { US: 'US', EU: 'EU', LATAM: 'LATAM', ANY: 'Any' };
const REGION_KEY = 'adderRegion';      // the region last picked — a batch of EU jobs stays EU
const DRAFT_KEY = 'adderDraft';        // survives closing and reopening the panel
const FIELDS = ['link', 'company', 'job_title', 'description', 'note'];
const REQUIRED = ['link', 'company', 'job_title', 'description'];
const LABEL = { link: 'job link', company: 'company', job_title: 'job title', description: 'job description' };
// The extractor's source keys vs the form's field names.
const SRC_KEY = { link: 'link', company: 'company', job_title: 'title', description: 'description' };
const blank = () => ({ link: '', company: '', job_title: '', description: '', note: '' });
const isWeb = (url) => /^https?:\/\//i.test(url || '');
// The server's submit rules (backend routers/jobs.py _clean_job_fields), checked as the form
// is filled, so Add & Next is only offered for a job the server will accept.
const MIN_DESCRIPTION = 100;
function jobProblems(f) {
  const out = [];
  const missing = REQUIRED.filter((k) => !String(f[k] || '').trim());
  if (missing.length) out.push(`Still needed: ${missing.map((k) => LABEL[k]).join(', ')}`);
  const link = String(f.link || '').trim();
  if (link) {
    let good = false;
    try { const u = new URL(link); good = /^https?:$/.test(u.protocol) && u.hostname.includes('.') && !/\s/.test(link); } catch { /* not a URL */ }
    if (!good) out.push('the job link must be a full web address (https://…)');
  }
  for (const k of ['company', 'job_title']) if (/^(https?:\/\/|www\.)/i.test(String(f[k] || '').trim())) out.push(`the ${LABEL[k]} looks like a link`);
  const desc = String(f.description || '').trim();
  if (desc && desc.length < MIN_DESCRIPTION) out.push(`the description is too short (${desc.length}/${MIN_DESCRIPTION} characters)`);
  return out;
}
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/**
 * @param {object} ctx
 * @param {(path: string, opts?: object) => Promise<any>} ctx.api  the panel's API wrapper (handles 401)
 * @param {() => Promise<string>} ctx.webBase  the TailorResume site, for "open in TailorResume" links
 * @param {(text: string) => void} ctx.toast
 * @param {() => Promise<boolean>} ctx.requestSiteAccess  must be the first await of a click
 */
export function createAdder(ctx) {
  const A = {
    root: null, visible: false,
    form: blank(), source: {},
    region: 'US',          // the adder's choice; never read from the page
    fetched: null,         // { tabId, url } — the tab the details came from (Add & Next closes it)
    tab: null,             // the active tab: { id, url, title }
    urlCheck: { state: 'idle', url: '', conflicts: [] },   // idle | notweb | checking | new | dup | error
    fetching: false, submitting: false,
    dup: { checking: false, conflicts: [] }, dupSeq: 0, dupTimer: 0,
    result: null,
    error: '', message: '',
  };
  let panelWindowId = null;
  chrome.windows.getCurrent().then((w) => { panelWindowId = w.id; }).catch(() => {});

  // ---------- persistence ----------
  let draftTimer = 0;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      chrome.storage.session.set({ [DRAFT_KEY]: { form: A.form, source: A.source, fetched: A.fetched } }).catch(() => {});
    }, 300);
  }
  const dropDraft = () => { clearTimeout(draftTimer); chrome.storage.session.remove(DRAFT_KEY).catch(() => {}); };
  async function loadDraft() {
    const got = await chrome.storage.local.get(REGION_KEY).catch(() => ({}));
    if (REGIONS.includes(got[REGION_KEY])) A.region = got[REGION_KEY];
    const { [DRAFT_KEY]: d } = await chrome.storage.session.get(DRAFT_KEY).catch(() => ({}));
    if (d?.form) {
      A.form = { ...blank(), ...d.form }; A.source = d.source || {};
      A.fetched = d.fetched || null;
    }
  }

  // ---------- alerts ----------
  function setError(msg) { A.error = msg || ''; if (msg) A.message = ''; patchAlerts(); }
  function setMessage(msg) { A.message = msg || ''; if (msg) A.error = ''; patchAlerts(); }

  // ---------- the active tab: is its URL already in TailorResume? ----------
  // Runs whenever the tab on screen changes (switch, navigate, load) while this view is
  // shown — before Fetch. Answers are cached for a minute so flipping between tabs is free.
  const urlCache = new Map();
  let urlSeq = 0, tabTimer = 0;
  const scheduleTabCheck = () => { clearTimeout(tabTimer); tabTimer = setTimeout(checkActiveTab, 200); };
  async function checkActiveTab() {
    if (!A.root || !A.visible) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    A.tab = tab ? { id: tab.id, url: tab.url || tab.pendingUrl || '', title: tab.title || '' } : null;
    const url = A.tab?.url || '';
    const my = ++urlSeq;
    if (!isWeb(url)) { A.urlCheck = { state: 'notweb', url, conflicts: [] }; patchTab(); return; }
    const hit = urlCache.get(url);
    if (hit && Date.now() - hit.at < 60_000) { A.urlCheck = { state: hit.conflicts.length ? 'dup' : 'new', url, conflicts: hit.conflicts }; patchTab(); return; }
    A.urlCheck = { state: 'checking', url, conflicts: [] }; patchTab();
    let next;
    try {
      const r = await ctx.api('/api/jobs/check-duplicate', { method: 'POST', body: { link: url, company: '', job_title: '', region: '' } });
      const conflicts = r?.conflicts || [];
      urlCache.set(url, { conflicts, at: Date.now() });
      next = { state: conflicts.length ? 'dup' : 'new', url, conflicts };
    } catch { next = { state: 'error', url, conflicts: [] }; }
    if (my === urlSeq) { A.urlCheck = next; patchTab(); }
  }
  chrome.tabs.onActivated.addListener(({ windowId }) => { if (panelWindowId == null || windowId === panelWindowId) scheduleTabCheck(); });
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (!tab.active || (panelWindowId != null && tab.windowId !== panelWindowId)) return;
    if (change.url || change.status === 'complete' || change.title) scheduleTabCheck();
  });

  // Close a job's tab and land on the tab to its right — or a new empty tab when it was
  // the last one (closing the window's only tab would close the window).
  async function closeAndNext(tabId, expectUrl) {
    if (tabId == null) return 'none';
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return 'gone';
    // The tab was navigated to another page since the fetch (e.g. the next job in a
    // LinkedIn list): that is not the job just added — leave it open.
    if (expectUrl && (tab.url || '') !== expectUrl) return 'moved';
    const all = await chrome.tabs.query({ windowId: tab.windowId });
    const next = all.filter((t) => t.index > tab.index).sort((a, b) => a.index - b.index)[0];
    if (next) await chrome.tabs.update(next.id, { active: true });
    else await chrome.tabs.create({ windowId: tab.windowId, active: true });
    await chrome.tabs.remove(tabId);
    return 'closed';
  }

  // ---------- fetch from the page ----------
  async function fetchFromPage() {
    // Reading other sites needs the optional site access. Chrome only shows the prompt
    // from a click, so this is the click handler's first await (granted → no prompt).
    const allowed = await ctx.requestSiteAccess();
    setError(''); setMessage(''); A.result = null; patchResult();
    if (!allowed) {
      setError('Reading the job page needs access to job sites and it was not allowed. Click Fetch Job Details again and choose "Allow" '
        + '— or open chrome://extensions → TailorResume Assistant → Details → Site access → "On all sites".');
      return;
    }
    A.fetching = true; patchForm();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab. Click the job posting tab, then try again.');
      const url = tab.url || tab.pendingUrl || '';
      if (url && !isWeb(url)) throw new Error('This tab is not a web page. Open the job posting in a normal tab and try again.');
      let results;
      try {
        results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractJobFromPage });
      } catch (e) {
        const msg = String(e?.message || e);
        if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\//i.test(msg)) {
          throw new Error('Chrome does not allow reading this page (browser and web-store pages are protected). Open the posting on the job board and try again.');
        }
        throw new Error(`Could not read the page: ${msg}`);
      }
      const data = results?.[0]?.result;
      if (!data) throw new Error('Could not read this page. If the posting is inside a frame, open it on its own and try again.');
      A.form = { ...A.form, link: data.link || url, company: data.company || '', job_title: data.title || '', description: data.description || '' };
      A.source = data.source || {};
      A.fetched = { tabId: tab.id, url };
      const missing = REQUIRED.filter((k) => !A.form[k].trim());
      setMessage(missing.length
        ? `Fetched. Please fill in: ${missing.map((k) => LABEL[k]).join(', ')}.`
        : `Fetched — check the details and the region (${REGION_LABEL[A.region]}), then Add & Next.`);
      ctx.toast('Details fetched');
      saveDraft(); scheduleDupCheck();
    } catch (e) { setError(e.message); } finally { A.fetching = false; patchForm(); }
  }

  // ---------- live duplicate check of the form (same rules as saving, read-only) ----------
  function scheduleDupCheck() {
    clearTimeout(A.dupTimer);
    const { company, job_title, link } = A.form;
    if (!company.trim() && !link.trim()) { A.dupSeq++; A.dup = { checking: false, conflicts: [] }; patchDup(); return; }
    const my = ++A.dupSeq;
    A.dup = { ...A.dup, checking: true }; patchDup();
    A.dupTimer = setTimeout(async () => {
      let conflicts = [];
      try {
        const r = await ctx.api('/api/jobs/check-duplicate', { method: 'POST', body: { company: company.trim(), job_title: job_title.trim(), link: link.trim(), region: A.region } });
        conflicts = r?.conflicts || [];
      } catch { /* never block on a failed check — the server re-checks on Add */ }
      if (my === A.dupSeq) { A.dup = { checking: false, conflicts }; patchDup(); }
    }, 500);
  }

  // ---------- Add & Next ----------
  const problems = () => jobProblems(A.form);
  async function submit() {
    setError(''); setMessage(''); A.result = null; patchResult();
    const f = A.form;
    const p = problems();
    if (p.length) { setError(`${p.join('; ')}.`.replace(/^./, (c) => c.toUpperCase())); return; }
    if (A.dup.conflicts.length) { setError('This job is a duplicate — see the notice above.'); return; }
    A.submitting = true; patchForm();
    const payload = {
      company: f.company.trim(), job_title: f.job_title.trim(), link: f.link.trim(), region: A.region,
      description: f.description.trim(), note: f.note.trim(), status: 'approved',
    };
    try {
      const job = await ctx.api('/api/jobs', { method: 'POST', body: { payload } });
      // The job's tab: the one it was fetched from — or, typed by hand, the active tab if it shows that link.
      let target = A.fetched;
      if (!target && A.tab?.url && A.tab.url === payload.link) target = { tabId: A.tab.id, url: A.tab.url };
      if (target?.url) urlCache.set(target.url, { conflicts: [{ kind: 'url', message: 'Just added.' }], at: Date.now() });
      A.form = blank(); A.source = {}; A.fetched = null;
      A.dupSeq++; A.dup = { checking: false, conflicts: [] };
      dropDraft();
      let closed = 'none';
      try { closed = await closeAndNext(target?.tabId, target?.url); } catch { /* tab vanished — nothing to close */ }
      A.result = { job: job || payload, closed };
      ctx.toast(`Added ${payload.company}`);
    } catch (e) { setError(e.message || String(e)); } finally { A.submitting = false; patchForm(); patchDup(); patchResult(); }
  }

  function clearForm() {
    A.form = blank(); A.source = {}; A.fetched = null; A.result = null;
    A.dupSeq++; A.dup = { checking: false, conflicts: [] };
    dropDraft();
    setError(''); setMessage(''); patchForm(); patchDup(); patchResult();
  }

  // The tab is already on file (or blocked): close it and go on without fetching.
  async function skipTab() {
    const t = A.tab; if (!t) return;
    if (A.fetched?.tabId === t.id) clearForm();
    await closeAndNext(t.id, t.url);
  }

  // ---------- render ----------
  function render() {
    A.root.innerHTML = `
      <main class="main">
        <div id="adAlerts" class="alerts" hidden></div>
        <div class="col">
          <section class="card" id="adTabCard">
            <div class="card-head"><span class="card-title">Job on this tab</span><span class="muted small ellipsis" id="adPage"></span></div>
            <div id="adUrlCheck"></div>
            <button id="adFetch" data-ad="fetch"></button>
          </section>
        </div>
        <div class="col">
          <section class="card" id="adForm">
            <div class="card-head"><span class="card-title">Job details</span><span class="muted small">All fields but questions are required</span></div>
            <label class="fld">
              <span class="fld-l">Job link <span class="src" id="adSrc_link"></span></span>
              <input id="ad_link" type="url" placeholder="https://…" autocomplete="off" spellcheck="false">
            </label>
            <div class="fld-2">
              <label class="fld"><span class="fld-l">Company <span class="src" id="adSrc_company"></span></span><input id="ad_company" autocomplete="off"></label>
              <label class="fld"><span class="fld-l">Region</span>
                <select id="adRegion">${REGIONS.map((r) => `<option value="${r}">${REGION_LABEL[r]}</option>`).join('')}</select></label>
            </div>
            <label class="fld"><span class="fld-l">Job title <span class="src" id="adSrc_job_title"></span></span><input id="ad_job_title" autocomplete="off"></label>
            <div id="adDup"></div>
            <label class="fld">
              <span class="fld-l">Job description <span class="src" id="adSrc_description"></span><span class="count" id="adCount"></span></span>
              <textarea id="ad_description" class="desc" placeholder="Full job description"></textarea>
            </label>
            <label class="fld">
              <span class="fld-l">Application questions <span class="muted">(optional, one per line)</span></span>
              <textarea id="ad_note" rows="2" placeholder="Why do you want to work here?"></textarea>
            </label>
            <div class="row">
              <button id="adSubmit" data-ad="submit" class="grow"></button>
              <button class="secondary" data-ad="clear" title="Clear the form">${I.eraser} Clear</button>
            </div>
            <div class="muted small" id="adProblems" hidden></div>
          </section>
          <section id="adResult" hidden></section>
        </div>
      </main>`;
    for (const k of FIELDS) {
      $(`#ad_${k}`, A.root).addEventListener('input', (e) => {
        A.form[k] = e.target.value;
        if (A.source[SRC_KEY[k]]) { delete A.source[SRC_KEY[k]]; patchSources(); }   // edited → no longer "from the page"
        if (k === 'description') patchCount();
        if (k === 'company' || k === 'job_title' || k === 'link') scheduleDupCheck();
        patchSubmit(); saveDraft();
      });
    }
    $('#adRegion', A.root).addEventListener('change', (e) => {
      A.region = e.target.value;
      chrome.storage.local.set({ [REGION_KEY]: A.region }).catch(() => {});
      scheduleDupCheck();   // one job per company per REGION per month — the region matters
    });
    A.root.onclick = onClick;
    patchAlerts(); patchTab(); patchForm(); patchDup(); patchResult();
  }

  function patchAlerts() {
    const el = $('#adAlerts', A.root); if (!el) return;
    const box = (kind, cls, msg) => `<div class="alert ${cls}"><span>${esc(msg)}</span><button class="alert-x" data-ad="dismiss" data-k="${kind}" title="Dismiss" aria-label="Dismiss">✕</button></div>`;
    el.innerHTML = (A.error ? box('error', 'error', A.error) : '') + (A.message ? box('message', 'ok', A.message) : '');
    el.hidden = !A.error && !A.message;
  }
  function patchTab() {
    const pt = $('#adPage', A.root); if (!pt) return;
    const t = A.tab;
    pt.textContent = t ? (hostOf(t.url) || t.title || '') : '';
    pt.title = t ? `${t.title}\n${t.url}` : '';
    const el = $('#adUrlCheck', A.root);
    const c = A.urlCheck;
    const skip = '<button class="secondary sm" data-ad="skipTab" title="Close this tab and go to the next one">Close tab &amp; next</button>';
    if (c.state === 'dup') {
      el.innerHTML = `<div class="alert error url-dup"><span><strong>Already in TailorResume</strong> — this page can't be added again.<ul>${c.conflicts.map((x) => `<li>${esc(x.message || x.kind)}</li>`).join('')}</ul></span></div><div class="row">${skip}</div>`;
    } else if (c.state === 'checking') el.innerHTML = '<div class="url-line muted"><span class="spinner"></span> Checking this page…</div>';
    else if (c.state === 'new') el.innerHTML = '<div class="url-line ok">✓ Not in TailorResume yet</div>';
    else if (c.state === 'error') el.innerHTML = '<div class="url-line muted">Couldn\'t check this page — the duplicate check runs again on Add.</div>';
    else if (c.state === 'notweb') el.innerHTML = '<div class="url-line muted">Open a job posting in this tab.</div>';
    else el.innerHTML = '';
    patchFetch();
  }
  function patchCount() {
    const el = $('#adCount', A.root); if (!el) return;
    const n = A.form.description.length;
    el.textContent = n ? `${n.toLocaleString()} chars` : '';
  }
  function patchSources() {
    for (const k of REQUIRED) {
      const el = $(`#adSrc_${k}`, A.root); if (!el) continue;
      const s = A.source[SRC_KEY[k]];
      el.textContent = s ? `from ${s}` : '';
    }
  }
  function patchFetch() {
    const fb = $('#adFetch', A.root); if (!fb) return;
    fb.disabled = A.fetching || A.submitting || A.urlCheck.state === 'notweb';
    fb.className = A.urlCheck.state === 'dup' ? 'secondary' : '';
    fb.innerHTML = A.fetching ? '<span class="spinner"></span> Reading page…' : `${I.fetch} Fetch Job Details`;
  }
  // Add & Next: only with every required field filled, no duplicate, nothing in flight.
  function patchSubmit() {
    const sb = $('#adSubmit', A.root); if (!sb) return;
    const p = problems();
    sb.disabled = A.submitting || A.fetching || p.length > 0 || A.dup.conflicts.length > 0;
    sb.title = p.length ? p.join(' · ') : 'Add the job, close its tab and go to the next tab';
    sb.innerHTML = A.submitting ? '<span class="spinner"></span> Adding…' : `Add &amp; Next ${I.next}`;
    // What still stops Add & Next — only once there is something in the form.
    const el = $('#adProblems', A.root);
    const touched = FIELDS.some((k) => A.form[k].trim());
    if (el) { el.hidden = !touched || !p.length; el.textContent = p.length ? `${p.join(' · ')}`.replace(/^./, (c) => c.toUpperCase()) : ''; }
  }
  function patchForm() {
    if (!A.root || !$('#adForm', A.root)) return;
    for (const k of FIELDS) { const el = $(`#ad_${k}`, A.root); if (el && el.value !== A.form[k]) el.value = A.form[k]; }
    $('#adRegion', A.root).value = A.region;
    for (const k of FIELDS) { const el = $(`#ad_${k}`, A.root); if (el) el.disabled = A.submitting; }
    $('#adRegion', A.root).disabled = A.submitting;
    patchFetch(); patchSubmit(); patchCount(); patchSources();
  }
  function patchDup() {
    const el = $('#adDup', A.root); if (!el) return;
    const { checking, conflicts } = A.dup;
    if (conflicts.length) {
      el.innerHTML = `<div class="alert error dup"><span><strong>Can't add — duplicate:</strong><ul>${conflicts.map((c) => `<li>${esc(c.message || c.kind)}</li>`).join('')}</ul></span></div>`;
    } else el.innerHTML = checking ? '<div class="muted small">Checking for duplicates…</div>' : '';
    patchSubmit();
  }
  function patchResult() {
    const el = $('#adResult', A.root); if (!el) return;
    const r = A.result;
    el.hidden = !r;
    if (!r) { el.innerHTML = ''; return; }
    el.className = 'card';
    const tabNote = { closed: 'Its tab is closed — this is the next one.', moved: 'Its tab was left open: it shows another page now.' }[r.closed] || '';
    el.innerHTML = `<div class="alert ok"><span><strong>Added</strong> · ${esc(r.job.company)} — ${esc(r.job.job_title)} · ${esc(REGION_LABEL[r.job.region] || r.job.region || '')}
      ${tabNote ? `<br><span class="small">${tabNote}</span>` : ''}</span></div>
      <div class="row"><button class="secondary sm" data-ad="openWeb">Open in TailorResume</button></div>`;
  }

  async function onClick(e) {
    const t = e.target.closest('[data-ad]'); if (!t || !A.root.contains(t)) return;
    try {
      switch (t.dataset.ad) {
        case 'fetch': await fetchFromPage(); break;
        case 'submit': await submit(); break;
        case 'clear': clearForm(); break;
        case 'skipTab': await skipTab(); break;
        case 'dismiss': if (t.dataset.k === 'error') setError(''); else setMessage(''); break;
        case 'openWeb': {
          const q = A.result?.job?.company || '';
          await chrome.tabs.create({ url: `${await ctx.webBase()}/jobs${q ? `?q=${encodeURIComponent(q)}` : ''}` });
          break;
        }
      }
    } catch (err) { setError(err?.message || String(err)); }
  }

  return {
    // Built on first show; later shows keep the form as it was and re-check the tab.
    async show(root) {
      A.visible = true;
      if (A.root !== root) {
        A.root = root;
        await loadDraft();
        render();
        if (A.form.company || A.form.link) scheduleDupCheck();
      }
      checkActiveTab();
    },
    hide() { A.visible = false; },
  };
}
