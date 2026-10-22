/* TailorResume side panel — the Bid tab's flow docked beside the job page.
 * Pick a profile (remembered) and a job. Jobs open in the panel's own "job tab"
 * (a new tab the first time — never over Gmail or whatever you were on), and
 * opening a queued job in a tab yourself selects it here.
 * Copy the ChatGPT prompt → paste the JSON → Generate CV (auto-downloads) →
 * Mark as Applied / Report / Skip, which moves on to the next job.
 * Autofill fills the application form (and attaches the CV) from the profile
 * plus answers learned per profile via Remember answers.
 * Vanilla JS, no deps (extension CSP forbids remote code). */

import { request, getConfig, setSession, clearSession } from '../lib/api.js';
import { requestSiteAccess, hasSiteAccess, autofillTab, collectAnswers } from './autofill-runner.js';

// ---------- tiny utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PROFILE_KEY = 'panelProfileId';

let toastTimer = null;
function toast(text) {
  const el = $('#toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

// ---------- icons ----------
const svg = (body) => `<svg viewBox="0 0 24 24">${body}</svg>`;
const I = {
  // Application details — name / email / phone / street / ZIP are VPS1's glyphs.
  name: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  email: svg('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.7a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.7A2 2 0 0 1 22 16.9z"/>'),
  street: svg('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
  city: svg('<path d="M3 21h18"/><rect x="4" y="9" width="7" height="12"/><rect x="13" y="4" width="7" height="17"/><path d="M7 13h1M7 17h1M16 8h1M16 12h1M16 16h1"/>'),
  state: svg('<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>'),
  zip: svg('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),
  address: svg('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  linkedin: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10.5V16"/><path d="M8 7.5h.01"/><path d="M12 16v-5.5M12 13a2.5 2.5 0 0 1 5 0v3"/>'),
  portfolio: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  company: svg('<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1"/><path d="M10 21v-3h4v3"/>'),
  school: svg('<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c2 2 10 2 12 0v-5"/><path d="M22 9v6"/>'),
  // Actions
  download: svg('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
  wand: svg('<path d="M15 4V2M15 10V8M11 6h2M17 6h2"/><path d="M3 21l11-11"/><path d="M12.5 8.5l3 3"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
};

// ---------- state ----------
const S = {
  screen: 'loading', user: null,
  profiles: [], profileId: '',
  queue: [], queueLoading: false,
  combo: { open: false, q: '', active: 0 },
  jobId: '', job: null,
  resumeId: '', ats: null, atsScore: 0, atsOpen: false,
  busy: '',            // '' | prompt | gen | dl | apply | report | skip
  confirm: '',         // '' | report | skip
  fill: { busy: '', report: null },   // autofill: busy '' | fill | learn
  error: '', message: '',
};

// ---------- api ----------
async function api(path, opts) {
  try { return await request(path, opts); } catch (e) {
    if (e?.status === 401) showLogin('Session expired — please sign in again.');
    throw e;
  }
}

// Bid audit trail — the same actions the web Bid tab records.
function track(action, job = currentJob()) {
  if (!job || !S.profileId) return;
  api('/api/resumes/bid/track', {
    method: 'POST',
    body: { action, profile_id: S.profileId, job_id: job.id, company: job.company || '', job_title: job.job_title || '' },
  }).catch(() => {});
}

// ---------- derived ----------
const selectedProfile = () => S.profiles.find((p) => p.id === S.profileId) || null;
const currentJob = () => S.queue.find((j) => j.id === S.jobId) || null;

function comboMatches() {
  const q = S.combo.q.trim().toLowerCase();
  if (!q) return S.queue;
  return S.queue.filter((j) => `${j.company} ${j.job_title} ${j.region}`.toLowerCase().includes(q));
}

// "Austin, TX" / "Austin, TX 78701" / "Austin, Texas, USA" → { city, state }.
function splitLocation(loc) {
  const parts = String(loc || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { city: parts[0] || '', state: (parts[1] || '').replace(/\s*\d{5}(-\d{4})?$/, '').trim() };
}

const INSTITUTION_RE = /\b(university|college|institute|school|academy|polytechnic|universidad|universit)/i;
function universityOf(p) {
  for (const e of p?.education_history || []) {
    const vals = ['university', 'degree', 'duration', 'location'].map((k) => String(e?.[k] || '').trim()).filter(Boolean);
    const hit = vals.find((v) => INSTITUTION_RE.test(v));
    if (hit) return hit;
    if (e?.university) return String(e.university).trim();
  }
  return '';
}

// Fixed, ordered application fields; empty ones render disabled.
function copyFields(p) {
  const v = (x) => String(x || '').trim();
  const { city, state } = splitLocation(p?.location);
  const street = v(p?.address);
  const zip = v(p?.zip_code);
  // The street field sometimes already holds the whole address — don't repeat city/state.
  const hasCity = city && street.toLowerCase().includes(city.toLowerCase());
  const full = hasCity
    ? [street, zip && !street.includes(zip) ? zip : ''].filter(Boolean).join(' ')
    : [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const latest = (p?.work_history || []).find((w) => v(w.company_name))?.company_name || '';
  return [
    ['Name', v(p?.name), I.name], ['Email', v(p?.email), I.email], ['Phone', v(p?.phone), I.phone],
    ['Street', street, I.street], ['City', city, I.city], ['State', state, I.state],
    ['ZIP', zip, I.zip], ['Address', v(full), I.address], ['LinkedIn', v(p?.linkedin), I.linkedin],
    ['Portfolio', v(p?.portfolio || p?.github), I.portfolio], ['Company', v(latest), I.company], ['University', v(universityOf(p)), I.school],
  ];
}

// ---------- browser ----------
async function copyText(text, label) {
  if (!text) { toast('Nothing to copy'); return false; }
  try { await navigator.clipboard.writeText(text); toast(`${label} copied`); return true; } catch { /* fallback below */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ok stays false */ }
  ta.remove(); toast(ok ? `${label} copied` : 'Clipboard blocked by the browser');
  return ok;
}

// The "job tab": the tab the panel shows jobs in. The active tab is reused only when
// it IS that tab or already shows a queued job — so the next job replaces the last
// one (or its thank-you page), but never Gmail or anything else the bidder was on:
// from there the job tab is brought back, and only if there is none yet does a new
// tab open (and become the job tab). Kept in session storage so it
// survives closing and reopening the panel.
let jobTabId = null;
const JOB_TAB_KEY = 'panelJobTab';
const setJobTab = (id) => { jobTabId = id; chrome.storage.session.set({ [JOB_TAB_KEY]: id }).catch(() => {}); };
chrome.tabs.onRemoved.addListener((id) => { if (id === jobTabId) setJobTab(null); });

async function showJob(job) {
  if (!job?.link) return;
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const jobTab = jobTabId != null ? await chrome.tabs.get(jobTabId).catch(() => null) : null;
    if (active?.id != null && (active.id === jobTabId || jobForUrl(active.url || ''))) {
      // On the job tab (or a queued job's page): the next job replaces it.
      if (active.url !== job.link) await chrome.tabs.update(active.id, { url: job.link });
      setJobTab(active.id);
    } else if (jobTab && jobTab.windowId === active?.windowId) {
      // On some other tab (Gmail…): leave it, bring the job tab back with this job.
      await chrome.tabs.update(jobTab.id, { url: job.link, active: true });
    } else {
      const tab = await chrome.tabs.create({ url: job.link, active: true });
      setJobTab(tab.id);
    }
    track('open_link', job);
  } catch { /* tab closed mid-way — the bidder can pick the job again */ }
}

// ---------- tab ↔ panel ----------
// A job's identity in a URL: host + path, plus any long id (Lever/Ashby uuid,
// Greenhouse job number) — so the posting page, its /apply form and a company
// site's embedded form (…?gh_jid=123) all map to the same job.
function urlKey(u) {
  try {
    const x = new URL(u);
    return { host: x.hostname.replace(/^www\./, ''), path: x.pathname.replace(/\/+$/, '').toLowerCase(), full: x.href.toLowerCase() };
  } catch { return null; }
}
function jobForUrl(url) {
  const t = urlKey(url); if (!t) return null;
  return S.queue.find((j) => {
    const k = urlKey(j.link); if (!k) return false;
    // Same page or deeper (Lever /apply, Ashby /application) — never a company's job index.
    if (k.host === t.host && k.path.length > 1 && t.path.startsWith(k.path)) return true;
    const id = (k.path.match(/[0-9a-f-]{8,}|\d{6,}/gi) || []).pop();
    return !!id && t.full.includes(id.toLowerCase());
  }) || null;
}
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  return tab || null;
}

// When the bidder opens a queued job in the tab themselves, select it here.
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => { panelWindowId = w.id; }).catch(() => {});
async function followTab(tabId, url) {
  if (S.screen !== 'main' || S.busy || S.fill.busy || !url) return;
  const job = jobForUrl(url);
  if (!job) return;
  setJobTab(tabId);                     // a tab showing a queued job is the job tab now
  if (job.id !== S.jobId) { await selectJob(job.id, { open: false }); toast(`Switched to ${job.company}`); }
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (windowId === panelWindowId) chrome.tabs.get(tabId).then((t) => followTab(tabId, t.url)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url && tab.active && tab.windowId === panelWindowId) followTab(tabId, change.url);
});

// ---------- autofill ----------
const SITE_ACCESS_HELP = 'Autofill needs access to job sites and it was not allowed. Click Autofill again and choose '
  + '"Allow" — or open chrome://extensions → TailorResume Assistant → Details → Site access → "On all sites".';

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open the job application in this tab first.');
  return tab.id;
}

async function cvPayload() {
  if (!S.resumeId) return null;
  const resp = await api(`/api/resumes/${encodeURIComponent(S.resumeId)}/pdf`, { raw: true });
  const blob = await resp.blob();
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
  const name = ((selectedProfile()?.name || 'Resume').trim() || 'Resume').replace(/[\\/:*?"<>|]+/g, '');
  return { base64, filename: `${name} resume.pdf` };
}

async function autofill() {
  if (!(await requestSiteAccess())) { setError(SITE_ACCESS_HELP); return; }
  S.fill = { busy: 'fill', report: null }; patchCopy();
  try {
    const tabId = await activeTabId();
    const [data, cv] = await Promise.all([
      api(`/api/autofill/data?profile_id=${encodeURIComponent(S.profileId)}`),
      cvPayload().catch(() => null),
    ]);
    const report = await autofillTab(tabId, { ...data, cv }, {
      onProgress: (r) => { S.fill.report = r; patchCopy(); },   // plain fields done; dropdowns next
    });
    S.fill.report = report;
    if (!report.fields && report.cv === 'none') setError('No application form found on this page — open the application, then Autofill.');
    else { setError(''); track('autofill'); }
  } finally { S.fill.busy = ''; patchCopy(); }
}

// Learn what the bidder filled by hand, so the same question fills itself next time.
async function rememberAnswers({ silent = false } = {}) {
  if (silent ? !(await hasSiteAccess()) : !(await requestSiteAccess())) {
    if (!silent) setError(SITE_ACCESS_HELP);
    return;
  }
  if (!silent) { S.fill.busy = 'learn'; patchCopy(); }
  try {
    const tabId = await activeTabId();
    const fields = await collectAnswers(tabId);
    if (!fields.length) { if (!silent) toast('No filled form fields on this page'); return; }
    const res = await api('/api/autofill/learn', { method: 'POST', body: { profile_id: S.profileId, fields } });
    if (!silent) toast(res.answers || res.labels ? `Remembered ${res.answers + res.labels} answer${res.answers + res.labels === 1 ? '' : 's'}` : 'Nothing new to remember');
  } catch (e) { if (!silent) throw e; }
  finally { if (!silent) { S.fill.busy = ''; patchCopy(); } }
}

// ---------- alerts ----------
function setError(msg) { S.error = msg || ''; if (msg) S.message = ''; patchAlerts(); }
function setMessage(msg) { S.message = msg || ''; if (msg) S.error = ''; patchAlerts(); }

// ---------- auth ----------
async function login(identifier, password) {
  S.screen = 'signing-in';  // keeps the storage listener from booting a second time
  try {
    const res = await request('/api/auth/login', { method: 'POST', body: { identifier, password, ttl_days: 30 } });
    await setSession({ token: res.token, user: res.user });
    S.user = res.user;
  } catch (e) { S.screen = 'login'; throw e; }
  S.screen = 'main'; renderMain(); await loadProfiles();
}

function showLogin(note) {
  Object.assign(S, { screen: 'login', profiles: [], queue: [], jobId: '', job: null, resumeId: '', ats: null });
  clearSession();
  renderLogin();
  if (note) setError(note);
}

// ---------- data ----------
async function loadProfiles() {
  $('#main').innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  let data;
  try { data = await api('/api/resumes/bid/profiles'); } catch (e) {
    renderMain();
    setError(e.status === 403 ? 'The side panel is for bidders and admins.' : e.message);
    return;
  }
  S.profiles = (data.profiles || []).filter((p) => p.status !== 'inactive');
  const { [PROFILE_KEY]: saved } = await chrome.storage.local.get(PROFILE_KEY);
  S.profileId = S.profiles.some((p) => p.id === saved) ? saved : (S.profiles[0]?.id || '');
  renderMain();
  await loadQueue({ open: true });
}

async function selectProfile(id) {
  S.profileId = id;
  await chrome.storage.local.set({ [PROFILE_KEY]: id });
  S.queue = []; S.jobId = '';
  patchCopy();
  await loadQueue({ open: true });
}

// Reload the queue. The current job is kept when it's still there; otherwise the
// job that took its place (same position) becomes current — so after Mark as
// Applied / Report / Skip the bidder lands on the next job.
async function loadQueue({ open = false } = {}) {
  const prevIdx = S.queue.findIndex((j) => j.id === S.jobId);
  S.queueLoading = true; patchJob();
  try {
    S.queue = S.profileId ? await api(`/api/resumes/bid?profile_id=${encodeURIComponent(S.profileId)}`) : [];
  } catch (e) { S.queue = []; setError(e.message); }
  S.queueLoading = false;
  const p = selectedProfile(); if (p) p.bid_count = S.queue.length;
  patchProfile();
  if (S.queue.some((j) => j.id === S.jobId)) { patchJob(); patchBuild(); return; }
  // The tab already shows a queued job (e.g. the panel opened mid-application): select
  // it instead of navigating the tab away from the bidder's work.
  const tab = open ? await activeTab() : null;
  const inTab = tab ? jobForUrl(tab.url || '') : null;
  if (inTab) { setJobTab(tab.id); await selectJob(inTab.id, { open: false }); return; }
  const next = S.queue[Math.max(0, Math.min(prevIdx, S.queue.length - 1))];
  await selectJob(next?.id || '', { open });
}

async function selectJob(id, { open = true } = {}) {
  const item = S.queue.find((j) => j.id === id) || null;
  Object.assign(S, {
    jobId: item ? id : '', job: null, confirm: '', atsOpen: false, fill: { busy: '', report: null },
    resumeId: item?.resume_id || '', ats: item?.ats || null, atsScore: item?.ats_score || 0,
  });
  const ta = $('#jsonInput'); if (ta) ta.value = '';
  patchJob(); patchBuild();
  if (!item) return;
  if (open) showJob(item);
  try {
    const detail = await api(`/api/resumes/bid-job/${encodeURIComponent(id)}`);
    if (S.jobId === id) { S.job = detail; patchJob(); }
  } catch { /* the queue row already has everything the panel shows */ }
}

// ---------- actions ----------
async function copyPrompt() {
  const job = currentJob(); if (!job) return;
  S.busy = 'prompt'; patchBuild();
  try {
    const { prompt } = await api(`/api/resumes/prompt?profile_id=${encodeURIComponent(S.profileId)}&job_id=${encodeURIComponent(job.id)}`);
    if (await copyText(prompt, 'ChatGPT prompt')) track('copy_prompt', job);
  } finally { S.busy = ''; patchBuild(); }
}

async function generate() {
  const job = currentJob(); if (!job) return;
  const text = ($('#jsonInput')?.value || '').trim();
  if (!text) { setError('Paste the JSON from ChatGPT first.'); $('#jsonInput')?.focus(); return; }
  setError(''); setMessage('');
  S.busy = 'gen'; patchBuild();
  try {
    const res = await api('/api/resumes/generate-from-json', {
      method: 'POST', body: { json_text: text, profile_id: S.profileId, job_id: job.id },
    });
    Object.assign(S, { resumeId: res.saved_resume_id || '', ats: res.ats || null, atsScore: res.ats_score || 0 });
    const item = currentJob(); if (item) Object.assign(item, { resume_id: S.resumeId, ats: S.ats, ats_score: S.atsScore });
    track('generate', job);
  } finally { S.busy = ''; patchBuild(); }
  if (S.resumeId) await download();   // auto-download, like VPS1
}

async function download() {
  const job = currentJob();
  if (!S.resumeId || !job) return;
  const name = ((selectedProfile()?.name || 'Resume').trim() || 'Resume').replace(/[\\/:*?"<>|]+/g, '');
  S.busy = 'dl'; patchBuild();
  try {
    const resp = await api(`/api/resumes/${encodeURIComponent(S.resumeId)}/pdf`, { raw: true });
    const blob = await resp.blob();
    if (!blob.size) throw new Error('The generated PDF is empty — try Generate CV again.');
    const url = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({ url, filename: `${name} resume.pdf`, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    if (id !== undefined) track('download', job);
  } finally { S.busy = ''; patchBuild(); }
}

async function finish(kind, run, note) {
  const job = currentJob(); if (!job) return;
  S.busy = kind; patchBuild();
  try {
    await run(job);
    setMessage(note(job));
    await loadQueue({ open: true });
  } finally { S.busy = ''; S.confirm = ''; patchBuild(); }
}

const markApplied = () => {
  if (!S.resumeId) { setError('Generate the CV before marking applied.'); return; }
  return finish('apply', async (job) => {
    // Learn from the form before the tab moves on to the next job.
    await rememberAnswers({ silent: true });
    track('mark_applied', job);
    await api(`/api/resumes/${encodeURIComponent(S.resumeId)}/apply`, { method: 'POST' });
  }, (job) => `Applied — ${job.company}.`);
};

const reportJob = () => {
  const reason = ($('#reportReason')?.value || '').trim();
  if (!reason) { $('#reportReason')?.focus(); return; }
  return finish('report', async (job) => {
    await api(`/api/jobs/${encodeURIComponent(job.id)}/reports`, { method: 'POST', body: { reason } });
    track('report', job);
  }, (job) => `Reported — ${job.company}.`);
};

const skipJob = () => finish('skip', async (job) => {
  await api('/api/resumes/bid/skip', { method: 'POST', body: { profile_id: S.profileId, job_id: job.id } });
  track('skip', job);
}, (job) => `Skipped — ${job.company}.`);

// ---------- rendering ----------
function renderLogin() {
  $('#app').innerHTML = `
    <div class="login">
      <div class="hero"><img src="../icons/icon128.png" alt=""><strong>TailorResume</strong><span class="muted small">Sign in to bid from the side panel</span></div>
      <div id="alerts"></div>
      <form id="loginForm" class="card">
        <label>Username or email<input name="identifier" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button id="loginBtn" type="submit">Sign in</button>
      </form>
    </div>`;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const btn = $('#loginBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try { await login(String(f.get('identifier')).trim(), String(f.get('password'))); }
    catch (err) { setError(err.message); btn.disabled = false; btn.textContent = 'Sign in'; }
  });
  patchAlerts();
}

function renderMain() {
  $('#app').innerHTML = `
    <main class="main" id="main">
      <div id="alerts"></div>
      <!-- Two columns when the panel is dragged wide (see panel.css); stacked otherwise. -->
      <div class="col">
        <select id="profileSelect" class="profile-select" title="Profile"></select>
        <section class="card" id="copyCard"></section>
      </div>
      <div class="col">
        <section class="card" id="jobCard">
          <div class="combo">
            <input id="jobSearch" autocomplete="off" spellcheck="false">
            <div class="combo-list" id="jobList" hidden></div>
          </div>
          <div id="jobLine"></div>
        </section>
        <section class="card" id="buildCard"></section>
      </div>
    </main>`;
  $('#app').onclick = onClick;
  $('#profileSelect').addEventListener('change', (e) => { setError(''); setMessage(''); selectProfile(e.target.value); });
  wireCombo();
  patchAlerts(); patchProfile(); patchJob(); patchBuild(); patchCopy();
}

// The job box shows the current job ("Company — Title") until you click into it;
// then the text is selected, so typing starts a search and Esc / leaving restores it.
const jobLabel = (j) => (j ? `${j.company} — ${j.job_title}` : '');

function wireCombo() {
  const input = $('#jobSearch');
  input.addEventListener('focus', () => {
    S.combo = { open: true, q: '', active: Math.max(0, S.queue.findIndex((j) => j.id === S.jobId)) };
    patchCombo();
    input.select();
  });
  input.addEventListener('input', () => { S.combo = { open: true, q: input.value, active: 0 }; patchCombo(); });
  input.addEventListener('blur', () => setTimeout(() => { S.combo.open = false; patchCombo(); }, 120));
  input.addEventListener('keydown', (e) => {
    const list = comboMatches();
    if (e.key === 'ArrowDown') { e.preventDefault(); S.combo.active = Math.min(S.combo.active + 1, list.length - 1); patchCombo(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); S.combo.active = Math.max(S.combo.active - 1, 0); patchCombo(); }
    else if (e.key === 'Enter') { e.preventDefault(); const j = list[S.combo.active]; if (j) pickJob(j.id); }
    else if (e.key === 'Escape') { input.blur(); }
  });
  // mousedown (not click) so the pick lands before the input's blur closes the list.
  $('#jobList').addEventListener('mousedown', (e) => {
    const it = e.target.closest('[data-job]'); if (!it) return;
    e.preventDefault(); pickJob(it.dataset.job);
  });
}

function pickJob(id) {
  S.combo = { open: false, q: '', active: 0 };
  $('#jobSearch').blur();
  setError(''); setMessage('');
  if (id !== S.jobId) selectJob(id); else showJob(currentJob());
}

function patchAlerts() {
  const el = $('#alerts'); if (!el) return;
  el.innerHTML = (S.error ? `<div class="alert error">${esc(S.error)}</div>` : '') + (S.message ? `<div class="alert ok">${esc(S.message)}</div>` : '');
  el.hidden = !S.error && !S.message;
}

function patchProfile() {
  const sel = $('#profileSelect'); if (!sel) return;
  sel.disabled = !S.profiles.length;
  sel.innerHTML = S.profiles.length
    ? S.profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === S.profileId ? 'selected' : ''}>${esc(p.name)} · ${p.bid_count ?? 0} to bid</option>`).join('')
    : '<option>No profiles assigned to you</option>';
}

function patchCombo() {
  const list = $('#jobList'), input = $('#jobSearch'); if (!list) return;
  input.placeholder = S.queueLoading ? 'Loading jobs…' : `Search ${S.queue.length} job${S.queue.length === 1 ? '' : 's'} by company or title…`;
  input.disabled = !S.queue.length;
  if (document.activeElement !== input) input.value = jobLabel(currentJob());
  list.hidden = !S.combo.open || !S.queue.length;
  if (list.hidden) return;
  const items = comboMatches().slice(0, 200);
  list.innerHTML = items.length ? items.map((j, i) => `
    <div class="combo-item ${i === S.combo.active ? 'active' : ''} ${j.id === S.jobId ? 'current' : ''}" data-job="${esc(j.id)}">
      <div class="t">${esc(j.company)}</div>
      <div class="s">${esc(j.job_title)} · ${esc(j.region || 'ANY')}${j.resume_id ? ' · CV ready' : ''}</div>
    </div>`).join('') : '<div class="combo-empty">No matching job</div>';
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function companyPill(info) {
  if (!info) return '';
  const key = info.status === 'pending' ? 'pending' : (info.verdict || 'unknown');
  const label = { startup: 'Startup', not_startup: 'Not startup', unknown: 'Unknown', pending: 'Checking…' }[key];
  const tip = [info.size_label, info.founded_label, info.reason].filter(Boolean).join(' · ');
  return `<span class="pill ${key}" title="${esc(tip)}">${label}</span>`;
}

function patchJob() {
  patchCombo();
  const el = $('#jobLine'); if (!el) return;
  const j = currentJob();
  if (!j) {
    el.innerHTML = `<div class="empty">${S.queueLoading ? '<span class="spinner"></span>' : (S.profileId ? 'No jobs left to bid for this profile.' : '')}</div>`;
    return;
  }
  const info = S.job?.company_info || j.company_info;
  el.innerHTML = `
    <div class="job-line">
      <span class="txt" title="${esc(`${j.job_title} · ${j.company} · ${j.region || 'ANY'}`)}"><a class="role" href="${esc(j.link)}" data-action="openJob">${esc(j.job_title)}</a> · ${esc(j.company)}</span>
      <span class="region">${esc(j.region || 'ANY')}</span>${companyPill(info)}
    </div>`;
}

const ATS_MAX = { 'Keyword Match': 30, 'Title Alignment': 15, 'Skills Alignment': 15, 'Experience Evidence': 20, Structure: 15, 'Fit Bonus': 10 };
const ATS_HELP = {
  'Keyword Match': 'Top 14 job keywords found anywhere in the CV',
  'Title Alignment': 'Job title in the headline and role titles',
  'Skills Alignment': 'Technical skills that exactly match job keywords',
  'Experience Evidence': 'Bullets naming job keywords and real tech',
  Structure: 'Headline, summary, skills, work history, education; summary 180–650 chars',
  'Fit Bonus': 'Extra credit for high keyword coverage and many exact matches',
};

function atsBreakdown() {
  const a = S.ats; if (!a) return '';
  const cats = a.category_scores || {};
  const sum = Object.values(cats).reduce((t, v) => t + (Number(v) || 0), 0);
  const floored = (a.overall_score || 0) > sum;
  return `
    <div class="ats">
      ${Object.entries(ATS_MAX).map(([k, max]) => {
        const v = Number(cats[k]) || 0;
        return `<div class="ats-row" title="${esc(ATS_HELP[k])}"><span>${esc(k)}</span><span class="ats-bar"><i style="width:${Math.round((v / max) * 100)}%"></i></span><span class="v">${v}/${max}</span></div>`;
      }).join('')}
      <div class="muted small">Total ${sum}${floored ? ` → raised to ${a.overall_score}: a ${a.overall_score >= 93 ? 'strong' : 'solid'} match is never scored below ${a.overall_score >= 93 ? 93 : 90}` : ''} · max 99</div>
      ${(a.matched_keywords || []).length ? `<div class="kw">${a.matched_keywords.map((k) => `<span class="hit">${esc(k)}</span>`).join('')}</div>` : ''}
      ${(a.missing_keywords || []).length ? `<div class="kw">${a.missing_keywords.map((k) => `<span class="miss">${esc(k)}</span>`).join('')}</div>` : ''}
    </div>`;
}

function patchBuild() {
  const el = $('#buildCard'); if (!el) return;
  const j = currentJob();
  el.hidden = !j;
  if (!j) return;
  const prev = $('#jsonInput')?.value ?? '';
  const b = S.busy, spin = '<span class="spinner"></span>';
  const score = S.atsScore;
  const tone = score >= 90 ? 'good' : score >= 75 ? 'mid' : 'low';
  el.innerHTML = `
    <div class="card-head"><span class="card-title">Build resume</span>
      ${S.resumeId && score ? `<button class="ats-badge ${tone}" data-action="toggleAts" title="${S.ats ? 'How this score is calculated' : 'ATS score'}">ATS ${score}${S.ats ? (S.atsOpen ? ' ▴' : ' ▾') : ''}</button>` : ''}</div>
    <div class="build-row">
      <button class="grow" data-action="copyPrompt" ${b ? 'disabled' : ''}>${b === 'prompt' ? spin : I.sparkle} Copy GPT Prompt</button>
      <button class="grow" data-action="generate" ${b ? 'disabled' : ''}>${b === 'gen' ? spin : 'Generate CV'}</button>
      <button class="icon secondary" data-action="download" ${S.resumeId && !b ? '' : 'disabled'} title="${S.resumeId ? 'Download the CV (PDF)' : 'Generate the CV first'}">${b === 'dl' ? spin : I.download}</button>
    </div>
    <textarea id="jsonInput" class="json" spellcheck="false" placeholder="Paste the JSON ChatGPT returned…"></textarea>
    ${S.atsOpen ? atsBreakdown() : ''}
    <div class="actions-3">
      <button data-action="confirmApply" ${S.resumeId && !b ? '' : 'disabled'} title="${S.resumeId ? 'Mark applied and go to the next job' : 'Generate the CV first'}">${b === 'apply' ? spin : 'Mark as Applied'}</button>
      <button class="danger" data-action="confirmReport" ${b ? 'disabled' : ''}>Report Job</button>
      <button class="warn" data-action="confirmSkip" ${b ? 'disabled' : ''} title="Not for this profile — removes the job from this profile's queue only">Skip Job</button>
    </div>
    ${S.confirm === 'apply' ? `
      <div class="confirm">
        <div>Mark <strong>${esc(j.company)}</strong> as applied? The next job opens in this tab.</div>
        <div class="row"><button class="grow" data-action="applySubmit" ${b ? 'disabled' : ''}>${b === 'apply' ? spin : 'Yes, applied'}</button><button class="secondary grow" data-action="cancelConfirm">Cancel</button></div>
      </div>` : ''}
    ${S.confirm === 'report' ? `
      <div class="confirm">
        <textarea id="reportReason" rows="2" placeholder="What's wrong? Link broken, posting closed, spam…"></textarea>
        <div class="row"><button class="danger grow" data-action="reportSubmit" ${b ? 'disabled' : ''}>${b === 'report' ? spin : 'Report'}</button><button class="secondary grow" data-action="cancelConfirm">Cancel</button></div>
      </div>` : ''}
    ${S.confirm === 'skip' ? `
      <div class="confirm">
        <div>Are you sure skip this job?</div>
        <div class="row"><button class="warn grow" data-action="skipSubmit" ${b ? 'disabled' : ''}>${b === 'skip' ? spin : 'Yes, skip'}</button><button class="secondary grow" data-action="cancelConfirm">Cancel</button></div>
      </div>` : ''}`;
  $('#jsonInput').value = prev;
  if (S.confirm === 'report' && !b) $('#reportReason')?.focus();
}

function patchCopy() {
  const el = $('#copyCard'); if (!el) return;
  const p = selectedProfile();
  el.hidden = !p;
  if (!p) return;
  const { busy, report } = S.fill, spin = '<span class="spinner"></span>';
  const CV_NOTE = { attached: 'CV attached', already: 'CV already attached', missing: 'generate the CV to attach it', failed: 'attach the CV by hand' };
  const required = (report?.unfilled || []).filter((u) => u.required);
  const optional = (report?.unfilled || []).length - required.length;
  el.innerHTML = `
    <div class="card-head"><span class="card-title ellipsis" title="${esc(p.name)} Details">${esc(p.name)} Details</span>
      <div class="pair">
        <button data-action="autofill" ${busy ? 'disabled' : ''} title="Fill this page's application form from the profile${S.resumeId ? ' and attach the CV' : ''}">${busy === 'fill' ? spin : I.wand} Autofill</button>
        <button class="secondary" data-action="remember" ${busy ? 'disabled' : ''} title="Save the answers you filled by hand — the same questions fill themselves next time for this profile">${busy === 'learn' ? spin : 'Remember'}</button>
      </div></div>
    ${report ? `
      <div class="fill-report">
        <div><strong>Filled ${report.filled.length}</strong>${CV_NOTE[report.cv] ? ` · ${CV_NOTE[report.cv]}` : ''}${report.typing ? ` · <span class="spinner"></span> ${report.typing} dropdown${report.typing === 1 ? '' : 's'}…` : ''}</div>
        ${required.length ? `<div class="muted small">Required — answer these, then click Remember:</div>
          <div class="kw">${required.slice(0, 10).map((u) => `<span class="todo" title="${esc(u.label)}">${esc(u.label.length > 44 ? u.label.slice(0, 42) + '…' : u.label)}</span>`).join('')}${required.length > 10 ? `<span class="todo">+${required.length - 10} more</span>` : ''}</div>` : ''}
        ${optional ? `<div class="muted small">${optional} optional field${optional === 1 ? '' : 's'} left empty</div>` : ''}
        ${report.note ? `<div class="small" style="color:var(--warning)">${esc(report.note)}</div>` : ''}
      </div>` : ''}
    <div class="copy-grid">${copyFields(p).map(([label, value, icon], i) => `
      <span class="copy-cell"><button class="copy-btn" data-action="copyField" data-i="${i}" ${value ? '' : 'disabled'} title="${esc(label)}${value ? ': ' + esc(value) : ' — not set'}" aria-label="Copy ${esc(label)}">${icon}</button><span class="lbl">${esc(label)}</span></span>`).join('')}</div>`;
}

// ---------- events ----------
async function onClick(e) {
  const t = e.target.closest('[data-action]'); if (!t) return;
  const a = t.dataset.action;
  try {
    switch (a) {
      case 'openJob': e.preventDefault(); await showJob(currentJob()); break;
      case 'copyPrompt': await copyPrompt(); break;
      case 'generate': await generate(); break;
      case 'download': await download(); break;
      case 'toggleAts': if (S.ats) { S.atsOpen = !S.atsOpen; patchBuild(); } break;
      case 'confirmApply': S.confirm = S.confirm === 'apply' ? '' : 'apply'; patchBuild(); break;
      case 'applySubmit': await markApplied(); break;
      case 'confirmReport': S.confirm = S.confirm === 'report' ? '' : 'report'; patchBuild(); break;
      case 'confirmSkip': S.confirm = S.confirm === 'skip' ? '' : 'skip'; patchBuild(); break;
      case 'cancelConfirm': S.confirm = ''; patchBuild(); break;
      case 'reportSubmit': await reportJob(); break;
      case 'skipSubmit': await skipJob(); break;
      case 'autofill': await autofill(); break;
      case 'remember': await rememberAnswers(); break;
      case 'copyField': {
        const f = copyFields(selectedProfile())[Number(t.dataset.i)];
        if (f && await copyText(f[1], f[0])) { t.classList.add('copied'); setTimeout(() => t.classList.remove('copied'), 900); }
        break;
      }
    }
  } catch (err) { if (S.screen === 'main') setError(err?.message || String(err)); }
}

// Follow the shared session: signed in from another panel window → load;
// session cleared (expired / 401) → back to sign-in.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('token' in changes)) return;
  const authed = !!changes.token.newValue;
  if (authed && S.screen === 'login') boot();
  else if (!authed && S.screen === 'main') showLogin();
});

// ---------- boot ----------
async function boot() {
  const { [JOB_TAB_KEY]: savedTab } = await chrome.storage.session.get(JOB_TAB_KEY).catch(() => ({}));
  if (savedTab != null) jobTabId = await chrome.tabs.get(savedTab).then((t) => t.id).catch(() => null);
  const cfg = await getConfig();
  S.user = cfg.user;
  if (!cfg.token) { S.screen = 'login'; renderLogin(); return; }
  S.screen = 'main';
  renderMain();
  await loadProfiles();
}
boot();
