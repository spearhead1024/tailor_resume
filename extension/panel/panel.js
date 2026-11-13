/* TailorResume side panel. Tabs by role: "Bid" (bidders) and "Add job" (job_adders,
 * panel/adder.js); admins get both.
 * Bid — the Bid tab's flow docked beside the job page.
 * With ChatGPT connected (gpt/runner.js), the CV of the job on screen and the next ones is
 * written and built in the background, so opening a job shows its CV ready to download;
 * the job's application questions (shared by all bidders) are answered in the same
 * ChatGPT conversation. Without it, the manual flow below still works.
 * Pick a profile (remembered) and a job. Jobs open in the panel's own "job tab"
 * (a new tab the first time — never over Gmail or whatever you were on), and
 * opening a queued job in a tab yourself selects it here.
 * By hand: copy the ChatGPT prompt → paste the JSON → Generate CV (saved to Downloads) →
 * Mark as Applied / Report / Skip, which moves on to the next job.
 * Autofill fills the application form (and attaches the CV) from the profile
 * plus answers learned per profile via Remember answers.
 * Vanilla JS, no deps (extension CSP forbids remote code). */

import { request, getConfig, setSession, clearSession } from '../lib/api.js';
import { requestSiteAccess, hasSiteAccess, autofillTab, collectAnswers } from './autofill-runner.js';
import { createAdder } from './adder.js';
import { gpt, gptSnapshot, onGptChange, requestChatAccess, threadKey } from '../gpt/client.js';
import { UPDATE_KEY, diskVersion } from '../lib/self-update.js';

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
  github: svg('<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.2-1.5 6.2-6.7a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.2-.3-3.8 1.4a13 13 0 0 0-7 0C6.4 1.3 5.2 1.6 5.2 1.6a4.8 4.8 0 0 0-.1 3.6A5.2 5.2 0 0 0 3.7 8.8c0 5.2 3.2 6.4 6.2 6.7a3.4 3.4 0 0 0-.9 2.6V22"/>'),
  portfolio: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  company: svg('<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1"/><path d="M10 21v-3h4v3"/>'),
  school: svg('<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c2 2 10 2 12 0v-5"/><path d="M22 9v6"/>'),
  // Actions
  download: svg('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
  refresh: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>'),
  wand: svg('<path d="M15 4V2M15 10V8M11 6h2M17 6h2"/><path d="M3 21l11-11"/><path d="M12.5 8.5l3 3"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
};

// ---------- state ----------
const S = {
  screen: 'loading', user: null,
  mode: '',            // the tab on screen: '' | bid | add
  bidStarted: false,   // the Bid view loads on its first show (it opens a job tab when it loads)
  gptSnap: null,       // the ChatGPT connection's state + threads, mirrored from chrome.storage
  questions: [],       // the job's application questions (shared by every bidder)
  answers: [],         // this CV's answers to them
  qaBusy: false, qaDraft: null,  // qaDraft: unsaved questions typed in the box (null = none)
  manual: false,       // show the copy-prompt / paste-JSON flow while ChatGPT is connected
  profiles: [], profileId: '',
  queue: [], queueLoading: false,
  combo: { open: false, q: '', active: 0 },
  jobId: '', job: null,
  resumeId: '', ats: null, atsScore: 0, atsOpen: false,
  busy: '',            // '' | prompt | gen | dl | apply | report | skip
  refreshing: false,
  netDown: false,
  previewOpen: (() => { try { return localStorage.getItem('panelPreviewOpen') !== '0'; } catch { return true; } })(),
  shortcut: null,      // the Autofill shortcut as Chrome reports it ('' = not set)
  confirm: '',         // '' | report | skip
  fill: { busy: '', report: null },   // autofill: busy '' | fill | learn
  error: '', message: '',
};

// ---------- api ----------
async function api(path, opts) {
  try {
    const res = await request(path, opts);
    if (S.netDown) networkBack();
    return res;
  } catch (e) {
    if (e?.status === 401) showLogin('Session expired — please sign in again.');
    throw e;
  }
}

// LinkedIn-hosted postings (Easy Apply) are left out of the panel's Bid queue — they get a
// flow of their own. The web Bid tab still lists them.
const BID_QUERY = 'skip_linkedin=1';

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
    ['GitHub', v(p?.github), I.github], ['Portfolio', v(p?.portfolio), I.portfolio],
    ['Company', v(latest), I.company], ['University', v(universityOf(p)), I.school],
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
  // 1) the exact posting URL
  let best = null, bestLen = -1;
  for (const j of S.queue) {
    const k = urlKey(j.link); if (!k) continue;
    if (k.full === t.full) return j;
    // 2) the same page or a page UNDER it (Lever /apply, Ashby /application) — on a path
    //    boundary, so /jobs/12 never matches /jobs/123, and the most specific job wins over
    //    one whose link is a careers index above it.
    if (k.host === t.host && k.path.length > 1 && (t.path === k.path || t.path.startsWith(k.path + '/'))
        && k.path.length > bestLen) { best = j; bestLen = k.path.length; }
  }
  if (best) return best;
  // 3) a long job id (Lever/Ashby uuid, Greenhouse number) anywhere in the URL (embeds, ?gh_jid=)
  return S.queue.find((j) => {
    const k = urlKey(j.link); if (!k) return false;
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

// The current CV's PDF, fetched once per resume and shared by the preview, Download
// and Autofill (which attaches it). The object URL lives as long as that resume is
// current; switching resumes revokes it.
let pdfCache = { id: '', promise: null, url: '' };
function cvBlob(id) {
  if (pdfCache.id !== id) {
    if (pdfCache.url) URL.revokeObjectURL(pdfCache.url);
    const entry = { id, url: '', promise: null };
    entry.promise = api(`/api/resumes/${encodeURIComponent(id)}/pdf`, { raw: true })
      .then((r) => r.blob())
      .then((b) => {
        if (!b.size) throw new Error('The generated PDF is empty — try Generate CV again.');
        if (pdfCache === entry) entry.url = URL.createObjectURL(b);
        return b;
      });
    entry.promise.catch(() => { if (pdfCache === entry) pdfCache = { id: '', promise: null, url: '' }; });
    pdfCache = entry;
  }
  return pdfCache.promise;
}
// "<Profile name> resume.pdf" — the same name the web app's Bid tab saves, so either place
// replaces the file the other saved. Made safe for every OS (Windows forbids \/:*?"<>| and
// a trailing dot or space; Chrome rejects control characters and a leading dot).
const cvFilename = () => {
  const name = String(selectedProfile()?.name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ')
    .trim().replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  return `${name || 'Resume'} resume.pdf`;
};

async function cvPayload() {
  if (!S.resumeId) return null;
  const blob = await cvBlob(S.resumeId);
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
  return { base64, filename: cvFilename() };
}

async function autofill({ fromShortcut = false } = {}) {
  if (S.fill.busy) return;                       // one run at a time (double click / shortcut)
  if (fromShortcut) {
    // Chrome only shows the site-access prompt for a click, not a key press.
    if (!(await hasSiteAccess())) { setError('Click Autofill once to allow access to job sites — after that the shortcut works too.', 10000); return; }
  } else if (!(await requestSiteAccess())) { setError(SITE_ACCESS_HELP); return; }
  if (S.fill.busy) return;                       // a second click got here while the first awaited
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
  if (!silent && S.fill.busy) return;
  if (silent ? !(await hasSiteAccess()) : !(await requestSiteAccess())) {
    if (!silent) setError(SITE_ACCESS_HELP);
    return;
  }
  if (!silent) {
    if (S.fill.busy) return;
    S.fill.busy = 'learn'; patchCopy();
  }
  try {
    const tabId = await activeTabId();
    const fields = await collectAnswers(tabId);
    if (!fields.length) { if (!silent) setError('No filled-in form fields on this page — answer the questions on the form, then click Remember.', 8000); return; }
    const res = await api('/api/autofill/learn', { method: 'POST', body: { profile_id: S.profileId, fields } });
    if (silent) return;
    // The autofill report's "answer these" list is now stale — clear it; the alert says what happened.
    S.fill.report = null;
    const n = (res.answers || 0) + (res.labels || 0);
    setMessage(n ? `Remembered ${n} answer${n === 1 ? '' : 's'} for ${selectedProfile()?.name || 'this profile'} — next time they fill in by themselves.`
      : 'Nothing new to remember — every answer on this form is already known.');
  } catch (e) { if (!silent) throw e; }
  finally { if (!silent) { S.fill.busy = ''; patchCopy(); } }
}

// ---------- alerts ----------
// Success notes fade after 6s. A network error fades after 10s, or the moment the
// server answers again / the browser is back online. Other errors stay until the
// next action or the ✕ — they need reading.
const NET_MSG = 'Network error — the server can\'t be reached. It clears when the connection is back.';
const alertTimers = {};
function setAlert(kind, msg, ttl = 0) {
  clearTimeout(alertTimers[kind]);
  S[kind] = msg || '';
  if (msg) S[kind === 'error' ? 'message' : 'error'] = '';
  if (msg && ttl) alertTimers[kind] = setTimeout(() => { if (S[kind] === msg) { S[kind] = ''; patchAlerts(); } }, ttl);
  patchAlerts();
}
function setError(msg, ttl = 0) { setAlert('error', msg, ttl); }
function setMessage(msg) { setAlert('message', msg, 6000); }
function showError(err) {
  if (err?.status === 0) { S.netDown = true; setError(NET_MSG, 10000); }
  else setError(err?.message || String(err));
}
function networkBack() {
  S.netDown = false;
  if (S.error === NET_MSG) setError('');
}
window.addEventListener('online', () => { if (S.netDown) networkBack(); });

// ---------- auth ----------
async function login(identifier, password) {
  S.screen = 'signing-in';  // keeps the storage listener from booting a second time
  try {
    const res = await request('/api/auth/login', { method: 'POST', body: { identifier, password, ttl_days: 30 } });
    await setSession({ token: res.token, user: res.user });
    S.user = res.user;
  } catch (e) { S.screen = 'login'; throw e; }
  await startMain();
}

function showLogin(note) {
  Object.assign(S, { screen: 'login', mode: '', bidStarted: false, profiles: [], queue: [], jobId: '', job: null, resumeId: '', ats: null });
  adder = null;
  clearSession();
  renderLogin();
  if (note) setError(note);
}

// ---------- data ----------
async function loadProfiles() {
  $('#main').innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  let data;
  try { data = await api(`/api/resumes/bid/profiles?${BID_QUERY}`); } catch (e) {
    if (e.status === 401) return;        // api() already showed the sign-in screen — don't cover it
    renderMain();
    if (e.status === 403) setError('The side panel is for bidders and admins.'); else showError(e);
    return;
  }
  S.profiles = (data.profiles || []).filter((p) => p.status !== 'inactive');
  const { [PROFILE_KEY]: saved } = await chrome.storage.local.get(PROFILE_KEY);
  S.profileId = S.profiles.some((p) => p.id === saved) ? saved : (S.profiles[0]?.id || '');
  renderMain();
  await loadQueue({ open: true });
}

// Re-read the to-bid counts and the queue in place — the current job, the pasted
// JSON and the job tab all stay put (unlike a full reload, nothing navigates).
async function refresh() {
  if (S.refreshing) return;
  S.refreshing = true; patchRefresh();
  try {
    const pid = S.profileId;
    const data = await api(`/api/resumes/bid/profiles?${BID_QUERY}`);
    S.profiles = (data.profiles || []).filter((p) => p.status !== 'inactive');
    if (S.profileId !== pid) return;     // the bidder switched profile meanwhile — that load wins
    if (!S.profiles.some((p) => p.id === S.profileId)) {
      S.profileId = S.profiles[0]?.id || '';
      await chrome.storage.local.set({ [PROFILE_KEY]: S.profileId });
    }
    patchProfile(); patchCopy();
    await loadQueue();
    toast('Refreshed');
  } finally { S.refreshing = false; patchRefresh(); }
}
function patchRefresh() {
  const b = $('#refreshBtn'); if (!b) return;
  b.disabled = S.refreshing;
  b.classList.toggle('spinning', S.refreshing);
}

async function selectProfile(id) {
  S.profileId = id;
  // Nothing of the previous profile may survive: its CV would otherwise be attached by Autofill
  // to a form being filled with the new profile's details.
  Object.assign(S, { queue: [], jobId: '', job: null, resumeId: '', ats: null, atsScore: 0,
    atsOpen: false, confirm: '', fill: { busy: '', report: null } });
  patchCopy(); patchBuild();
  await chrome.storage.local.set({ [PROFILE_KEY]: id });
  await loadQueue({ open: true });
}

// Reload the queue. The current job is kept when it's still there; otherwise the
// job that took its place (same position) becomes current — so after Mark as
// Applied / Report / Skip the bidder lands on the next job.
async function loadQueue({ open = false } = {}) {
  const prevIdx = S.queue.findIndex((j) => j.id === S.jobId);
  const pid = S.profileId;
  S.queueLoading = true; patchJob();
  let queue = [];
  try {
    queue = pid ? await api(`/api/resumes/bid?profile_id=${encodeURIComponent(pid)}&${BID_QUERY}`) : [];
  } catch (e) { if (S.profileId === pid) showError(e); }
  // A late answer for a profile that is no longer selected must not replace the current queue.
  if (S.profileId !== pid) return;
  S.queue = queue;
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
    jobId: item ? id : '', job: null, confirm: '', atsOpen: false, fill: { busy: S.fill.busy, report: null },
    resumeId: item?.resume_id || '', ats: item?.ats || null, atsScore: item?.ats_score || 0,
  });
  const ta = $('#jsonInput'); if (ta) ta.value = '';
  patchJob(); patchBuild();
  if (!item) return;
  if (open) showJob(item);
  S.questions = []; S.answers = []; S.qaDraft = null; S.manual = false;
  const card = $('#qaCard'); if (card) card.innerHTML = '';   // a new job: a fresh questions box
  patchQA();
  gptPrepare();
  if (S.resumeId) loadAnswers();
  try {
    const detail = await api(`/api/resumes/bid-job/${encodeURIComponent(id)}`);
    if (S.jobId === id) { S.job = detail; S.questions = detail.questions || []; patchJob(); patchQA(); }
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
  // Pin the job and profile: the CV belongs to THEM, whatever is selected when the answer comes.
  const jobId = job.id, profileId = S.profileId;
  let rid = '';
  S.busy = 'gen'; patchBuild();
  try {
    const res = await api('/api/resumes/generate-from-json', {
      method: 'POST', body: { json_text: text, profile_id: profileId, job_id: jobId },
    });
    rid = res.saved_resume_id || '';
    const fresh = { resume_id: rid, ats: res.ats || null, ats_score: res.ats_score || 0 };
    const item = S.profileId === profileId ? S.queue.find((j) => j.id === jobId) : null;
    if (item) Object.assign(item, fresh);
    if (S.jobId === jobId && S.profileId === profileId) Object.assign(S, { resumeId: rid, ats: fresh.ats, atsScore: fresh.ats_score });
    track('generate', job);
  } finally { S.busy = ''; patchBuild(); }
  if (rid && S.jobId === jobId && S.resumeId === rid) await download();   // straight to Downloads, replacing
}

// Save the CV straight into Downloads, REPLACING a file of the same name — the bidder always
// has the current CV under one name, never "… (1).pdf". (The Download CV button, and right
// after Generate CV.)
async function download() {
  const job = currentJob();
  if (!S.resumeId || !job) return;
  S.busy = 'dl'; patchBuild();
  const filename = cvFilename();
  try {
    const blob = await cvBlob(S.resumeId);
    const url = URL.createObjectURL(blob);
    const outcome = await saveFile({ url, filename, saveAs: false, conflictAction: 'overwrite' });
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    if (outcome === 'complete') { track('download', job); toast(`Saved ${filename} to Downloads`); }
    else if (outcome === 'locked') setError(`Could not replace ${filename}: that file is open in another program (a PDF viewer?). Close it, then click ⬇ to save again.`);
    else if (outcome === 'failed') setError(`Could not save ${filename}. Click ⬇ to try again.`);
    // 'cancelled' (Save As closed) is a choice, not an error.
  } finally { S.busy = ''; patchBuild(); }
}
// chrome.downloads.download, resolved with how it ENDED: 'complete' | 'locked' (the file to
// replace is in use) | 'cancelled' | 'failed'. The download id comes back before the file is
// written, so the outcome is read from downloads.onChanged.
function saveFile(opts) {
  return new Promise((resolve) => {
    let id = null, settled = false;
    const done = (v) => { if (settled) return; settled = true; chrome.downloads.onChanged.removeListener(onChanged); clearTimeout(timer); resolve(v); };
    function onChanged(d) {
      if (id === null || d.id !== id) return;
      if (d.state?.current === 'complete') done('complete');
      else if (d.state?.current === 'interrupted') {
        const err = String(d.error?.current || '');
        done(err === 'USER_CANCELED' ? 'cancelled' : /^FILE_(ACCESS_DENIED|BLOCKED|FAILED|NO_SPACE|TOO_LARGE|TRANSIENT_ERROR)$/.test(err) ? 'locked' : 'failed');
      }
    }
    // A Save As dialog can stay open for long; a silent save is done in seconds.
    const timer = setTimeout(() => done('complete'), opts.saveAs ? 10 * 60_000 : 30_000);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.download(opts).then((downloadId) => {
      id = downloadId;
      // It may have finished before the listener could see it.
      chrome.downloads.search({ id }).then(([it]) => {
        if (it?.state === 'complete') done('complete');
        else if (it?.state === 'interrupted') onChanged({ id, state: { current: 'interrupted' }, error: { current: it.error } });
      }).catch(() => {});
    }, (e) => done(/cancel/i.test(e?.message || '') ? 'cancelled' : 'failed'));
  });
}

async function finish(kind, run, note) {
  const job = currentJob(); if (!job) return;
  S.busy = kind; patchBuild();
  try {
    await run(job);
    // Done with this job: the server closes its queue row (its ChatGPT conversation gets deleted).
    if (gptOn()) gpt('sync').catch(() => {});
    setMessage(note(job));
    await loadQueue({ open: true });
  } finally { S.busy = ''; S.confirm = ''; patchBuild(); }
}

const markApplied = () => {
  const rid = S.resumeId;                // read before any await — it's THIS job's CV
  if (!rid) { setError('Generate the CV before marking applied.'); return; }
  return finish('apply', async (job) => {
    // Learn from the form before the tab moves on to the next job.
    await rememberAnswers({ silent: true });
    track('mark_applied', job);
    await api(`/api/resumes/${encodeURIComponent(rid)}/apply`, { method: 'POST' });
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

const SKIP_REASONS = ['Location / region', 'Tech stack mismatch', 'Seniority mismatch', 'Already applied'];
const skipJob = () => {
  const reason = ($('#skipReason')?.value || '').trim();
  if (!reason) { $('#skipReason')?.focus(); setError('Pick or type a reason for skipping.', 6000); return; }
  return finishSkip(reason);
};
const finishSkip = (reason) => finish('skip', async (job) => {
  await api('/api/resumes/bid/skip', { method: 'POST', body: { profile_id: S.profileId, job_id: job.id, reason } });
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
    catch (err) { showError(err); btn.disabled = false; btn.textContent = 'Sign in'; }
  });
  patchAlerts();
}

// ---------- ChatGPT connection (gpt/runner.js) ----------
const gptOn = () => !!S.gptSnap?.state.enabled;
const currentThread = () => (S.gptSnap && S.profileId && S.jobId ? S.gptSnap.threads[threadKey(S.profileId, S.jobId)] || null : null);

// The job on screen and the next ones without a CV (5 in all) are written ahead.
function gptPrepare() {
  if (!gptOn() || !S.profileId || !S.jobId) return;
  const i = Math.max(0, S.queue.findIndex((j) => j.id === S.jobId));
  const jobs = S.queue.slice(i, i + 20).map((j) => ({ id: j.id, company: j.company, job_title: j.job_title }));
  // The server keeps the queue (3 ahead, skipping jobs with a CV); the worker is told to look.
  if (jobs.length) api('/api/gpt/prepare', { method: 'POST', body: { profile_id: S.profileId, jobs } }).then(() => gpt('sync')).catch(() => {});
}
async function connectGpt() {
  const ok = await requestChatAccess();   // first await of the click — Chrome's prompt needs it
  if (!ok) { setError('Connecting needs access to chatgpt.com. Click Connect ChatGPT again and choose Allow.'); return; }
  await gpt('connect');
  S.gptSnap = await gptSnapshot();
  toast('Checking your ChatGPT account — a paid plan is required');
  gptPrepare(); patchBuild();
}
// A CV the background built: adopt it (for the job on screen and the ones queued after it).
function adoptBuiltCvs() {
  if (!S.gptSnap || !S.profileId) return;
  let current = false;
  for (const t of Object.values(S.gptSnap.threads)) {
    if (t.profileId !== S.profileId || !t.resumeId) continue;
    const item = S.queue.find((j) => j.id === t.jobId);
    if (item && !item.resume_id) Object.assign(item, { resume_id: t.resumeId, ats: t.ats || null, ats_score: t.atsScore || 0 });
    if (t.jobId === S.jobId && !S.resumeId && !S.busy) {
      Object.assign(S, { resumeId: t.resumeId, ats: t.ats || null, atsScore: t.atsScore || 0 });
      current = true;
    }
  }
  if (current) { patchBuild(); loadAnswers(); }
}
let lastWant = '';
onGptChange(async () => {
  S.gptSnap = await gptSnapshot();
  adoptBuiltCvs();
  patchGptLine();
  // Answers landed (the thread's pending questions shrank): read them again.
  const t = currentThread(), want = JSON.stringify(t?.want || []);
  if (want !== lastWant && S.resumeId) { lastWant = want; loadAnswers(); }
  else { lastWant = want; patchQA(); }   // status lines (e.g. waiting for a paid account) follow the connection
});

// ChatGPT's own plan ids → names. Only paid plans are ever accepted (gpt/driver.js).
const PLAN_NAMES = { plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', go: 'Go' };
const planLabel = (p) => PLAN_NAMES[p] || (p === 'paid' ? 'paid plan' : p.replace(/_/g, ' '));

function patchGptLine() {
  const el = $('#gptLine'); if (!el) return;
  const st = S.gptSnap?.state || {}, t = currentThread();
  let cls = 'muted', text = '', btn = '';
  if (!st.enabled) {
    text = 'ChatGPT is not connected — the CV is written by hand below. (A paid ChatGPT plan is required.)';
    btn = '<button class="sm" data-action="gptConnect">Connect ChatGPT</button>';
  } else if (st.status === 'checking') {
    text = '<span class="spinner"></span> Checking your ChatGPT account (a paid plan is required)…';
  } else if (st.status === 'needs_login' || st.status === 'needs_plan') {
    cls = st.status === 'needs_plan' ? 'error' : 'warn';
    text = st.notice || 'Sign in to chatgpt.com in this browser with a paid account, then press Continue.';
    btn = '<button class="secondary sm" data-action="gptSignIn">Open ChatGPT</button><button class="sm" data-action="gptContinue">Continue</button>';
  } else if (S.resumeId) {
    cls = 'ok'; text = t?.resumeId === S.resumeId ? 'CV written by ChatGPT and built.' : 'CV built.';
  } else if (!t) {
    text = 'Queuing this job for ChatGPT…';
  } else if (t.stage === 'failed') {
    cls = 'error'; text = `ChatGPT could not write it — ${t.error || 'unknown error'}`;
    btn = '<button class="secondary sm" data-action="gptRetry">Retry</button>';
  } else if (t.stage === 'writing') text = `<span class="spinner"></span> ChatGPT is writing this CV${t.attempts > 1 ? ` (try ${t.attempts})` : ''}…`;
  else if (st.status === 'limited') { cls = 'warn'; text = st.notice; }
  else {
    const ahead = Object.values(S.gptSnap.threads).filter((x) => x.work && x.key !== t.key).length;
    text = `Waiting for a free ChatGPT tab${ahead ? ` (${ahead} working)` : ''}…`;
  }
  const mine = Object.values(S.gptSnap?.threads || {}).filter((x) => x.profileId === S.profileId && x.stage !== 'closing');
  const ready = mine.filter((x) => x.stage === 'ready').length;
  const plan = st.plan && st.status !== 'needs_plan' ? `ChatGPT ${esc(planLabel(st.plan))} · ` : '';
  const meta = st.enabled ? `<span class="gpt-meta">${plan}${ready}/${mine.length} ready · <a href="#" data-action="gptDisconnect" title="Stop writing CVs with ChatGPT">Disconnect</a></span>` : '';
  el.className = `gpt-line ${cls}`;
  el.innerHTML = `<span class="txt">${text.startsWith('<span') ? text : esc(text)}</span>${btn}${meta}`;
}

// ---------- application questions (shared per job) + this CV's answers ----------
async function loadAnswers() {
  const rid = S.resumeId;
  if (!rid) { S.answers = []; patchQA(); return; }
  try { const r = await api(`/api/resumes/${encodeURIComponent(rid)}/answers`); if (S.resumeId === rid) S.answers = r.answers || []; }
  catch { /* keeps what it had */ }
  patchQA();
}
function answerFor(q) { return S.answers.find((a) => a.question.toLowerCase() === q.toLowerCase())?.answer || ''; }
// A new chat needs the job (and the CV, if it was pasted) when no ChatGPT conversation wrote it.
function answerContext() {
  const j = currentJob(), p = selectedProfile();
  const pasted = ($('#jsonInput')?.value || '').trim();
  return [`JOB: ${j?.job_title} at ${j?.company}`, S.job?.description ? `JOB DESCRIPTION:\n${String(S.job.description).slice(0, 6000)}` : '',
    `CANDIDATE: ${p?.name || ''}`, pasted ? `CANDIDATE RESUME (JSON):\n${pasted.slice(0, 9000)}` : ''].filter(Boolean).join('\n\n');
}
async function askAnswers() {
  const missing = S.questions.filter((q) => !answerFor(q));
  if (!missing.length || !gptOn()) return;
  const j = currentJob();
  await api('/api/gpt/want', { method: 'POST', body: { profile_id: S.profileId, job_id: S.jobId, resume_id: S.resumeId, questions: missing,
    company: j?.company || '', job_title: j?.job_title || '', context: answerContext() } }).then(() => gpt('sync')).catch(() => {});
}
async function saveQuestions() {
  const jobId = S.jobId; if (!jobId) return;
  const text = $('#qaInput')?.value || '';
  S.qaBusy = true; patchQA();
  try {
    const r = await api(`/api/resumes/bid-job/${encodeURIComponent(jobId)}/questions`, { method: 'PUT', body: { questions: text } });
    if (S.jobId !== jobId) return;
    S.questions = r.questions || []; S.qaDraft = null;
    const box = $('#qaInput'); if (box) box.blur();   // show the saved (cleaned) list
    toast(S.questions.length ? 'Questions saved for every bidder' : 'Questions cleared');
    await askAnswers();
  } finally { S.qaBusy = false; patchQA(); }
}
// The textarea is built once per card and never redrawn under the user: what they type is a
// draft (S.qaDraft) until saved or the job changes; only the answers below update live.
function patchQA() {
  const el = $('#qaCard'); if (!el) return;
  el.hidden = !currentJob();
  if (el.hidden) return;
  if (!$('#qaInput', el)) {
    el.innerHTML = `
      <div class="card-head"><span class="card-title">Application questions</span><span id="qaCopyAll"></span></div>
      <textarea id="qaInput" rows="3" placeholder="One question per line — e.g.&#10;Briefly explain your recent project&#10;Why are you interested in this role?"></textarea>
      <div class="row"><button class="grow" id="qaSave" data-action="saveQuestions"></button></div>
      <div class="muted small">Shared with every bidder on this job. Answered in the ChatGPT conversation that wrote this CV — 2–3 sentences each.</div>
      <div id="qaErr"></div>
      <div class="qa-list" id="qaList"></div>`;
    $('#qaInput', el).addEventListener('input', (e) => { S.qaDraft = e.target.value; });
  }
  const box = $('#qaInput', el);
  if (S.qaDraft == null && document.activeElement !== box) {
    box.value = S.questions.join('\n');
    box.rows = Math.min(6, Math.max(3, S.questions.length + 1));
  }
  const save = $('#qaSave', el);
  save.disabled = S.qaBusy;
  save.innerHTML = S.qaBusy ? '<span class="spinner"></span> Saving…' : 'Save questions &amp; answer';
  $('#qaCopyAll', el).innerHTML = S.answers.length ? `<button class="secondary sm" data-action="copyAllAnswers">${I.copy} Copy all</button>` : '';
  const t = currentThread(), pending = new Set((t?.want || []).map((q) => q.toLowerCase()));
  $('#qaErr', el).innerHTML = t?.error && /^Answers/.test(t.error) ? `<div class="alert error"><span>${esc(t.error)}</span></div>` : '';
  const writing = t && ['queued', 'writing', 'building'].includes(t.stage);
  $('#qaList', el).innerHTML = S.questions.map((q, i) => {
    const a = answerFor(q);
    const busy = writing || pending.has(q.toLowerCase());
    const blocked = ['needs_plan', 'needs_login', 'checking'].includes(S.gptSnap?.state.status);
    const state = a ? '' : !gptOn() ? 'Connect ChatGPT to answer it.'
      : blocked ? 'Answered once a paid ChatGPT account is confirmed.'
      : busy ? '<span class="spinner"></span> ChatGPT is answering…'
      : S.resumeId ? 'Not answered yet — press Save questions &amp; answer.' : 'Answered once the CV is written.';
    return `<div class="qa-row">
      <div class="row space"><strong class="q">${esc(q)}</strong>${a ? `<button class="sm" data-action="copyAnswer" data-i="${i}">${I.copy} Copy</button>` : ''}</div>
      ${a ? `<div class="a">${esc(a)}</div>` : `<div class="muted small">${state}</div>`}
    </div>`;
  }).join('');
}

// ---------- a newer version is on disk (the updater put it there) ----------
async function patchUpdateBar() {
  const el = $('#updateBar'); if (!el) return;
  const running = chrome.runtime.getManifest().version;
  const disk = await diskVersion();
  el.hidden = !disk || disk === running;
  if (!el.hidden) el.innerHTML = `<span>Version ${esc(disk)} is installed — restart to use it.</span><button class="sm" data-action="restartExt">Restart now</button>`;
}
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && UPDATE_KEY in ch) patchUpdateBar(); });

// ---------- tabs by role ----------
// Bid: bidders and admins (the Bid API's own rule). Add job: job_adders and admins
// (the Jobs API's rule). Someone with both gets both tabs; the last one used is kept.
const MODE_KEY = 'panelMode';
const hasRole = (u, ...roles) => !!u && (roles.includes('admin') && u.is_admin || roles.some((r) => (u.roles || []).includes(r)));
const MODES = [
  { id: 'bid', label: 'Bid', allowed: (u) => hasRole(u, 'admin', 'bidder') },
  { id: 'add', label: 'Add job', allowed: (u) => hasRole(u, 'admin', 'job_adder') },
];
const availableModes = () => MODES.filter((m) => m.allowed(S.user)).map((m) => m.id);

let adder = null;
const getAdder = () => adder || (adder = createAdder({
  api, toast, requestSiteAccess,
  webBase: async () => (await getConfig()).apiBase,
}));

// Signed in: re-read who this is (roles can change after sign-in), then show the tabs.
async function startMain() {
  S.screen = 'main';
  S.gptSnap = await gptSnapshot();
  try {
    const me = await request('/api/auth/me');
    if (me?.id) { S.user = me; await chrome.storage.local.set({ user: me }); }
  } catch (e) {
    if (e?.status === 401) { showLogin('Session expired — please sign in again.'); return; }
    // offline / server down: the stored user decides the tabs
  }
  const modes = availableModes();
  if (!modes.length) { renderNoAccess(); return; }
  renderFrame(modes);
  patchUpdateBar();
  const { [MODE_KEY]: saved } = await chrome.storage.local.get(MODE_KEY).catch(() => ({}));
  // The Autofill shortcut was pressed on a job page: that is Bid's job.
  const { [AUTOFILL_REQ]: req } = await chrome.storage.session.get(AUTOFILL_REQ).catch(() => ({}));
  const mode = req && modes.includes('bid') ? 'bid' : (modes.includes(saved) ? saved : modes[0]);
  await setMode(mode);
  if (mode === 'bid' && await takeAutofillRequest()) autofill({ fromShortcut: true }).catch(showError);
}

function renderFrame(modes) {
  const u = S.user || {};
  const tabs = modes.length > 1
    ? `<nav class="modes" role="tablist">${modes.map((id) => {
      const m = MODES.find((x) => x.id === id);
      return `<button role="tab" class="mode" data-action="mode" data-mode="${id}" aria-selected="false">${esc(m.label)}</button>`;
    }).join('')}</nav>`
    : `<span class="mode-one">${esc(MODES.find((x) => x.id === modes[0]).label)}</span>`;
  $('#app').innerHTML = `
    <header class="topbar">
      ${tabs}
      <span class="who ellipsis" title="${esc(u.full_name || u.username || '')} · TailorResume Assistant v${esc(chrome.runtime.getManifest().version)}">${esc(u.username || '')}</span>
      <button class="icon secondary" data-action="logout" title="Sign out">${I.logout}</button>
    </header>
    <div class="update-bar" id="updateBar" hidden></div>
    <div id="bidView" role="tabpanel" hidden></div>
    <div id="addView" role="tabpanel" hidden></div>`;
  $('#app').onclick = onClick;
  // Reason chips are spans (not buttons, so they keep their small pill size): Enter / Space click them.
  $('#app').onkeydown = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.chip')) { e.preventDefault(); e.target.click(); }
  };
}

async function setMode(mode) {
  if (!availableModes().includes(mode)) return;
  S.mode = mode;
  chrome.storage.local.set({ [MODE_KEY]: mode }).catch(() => {});
  document.querySelectorAll('.modes .mode').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  $('#bidView').hidden = mode !== 'bid';
  $('#addView').hidden = mode !== 'add';
  if (mode !== 'add') adder?.hide();   // its tab-URL checks run only while it is on screen
  if (mode === 'bid' && !S.bidStarted) {
    S.bidStarted = true;
    renderMain(); loadShortcut();
    await loadProfiles();
  } else if (mode === 'add') {
    await getAdder().show($('#addView'));
  }
}

function renderNoAccess() {
  S.screen = 'noaccess';
  const u = S.user || {};
  $('#app').innerHTML = `
    <div class="login">
      <div class="hero"><img src="../icons/icon128.png" alt=""><strong>TailorResume</strong></div>
      <div class="alert error"><span>This panel is for bidders and job adders. <b>${esc(u.username || 'Your account')}</b> has neither role — ask an admin.</span></div>
      <button class="secondary" data-action="logout">Sign out</button>
    </div>`;
  $('#app').onclick = onClick;
}

function renderMain() {
  previewKey = '';   // fresh #previewCard — let patchPreview draw it again
  $('#bidView').innerHTML = `
    <main class="main" id="main">
      <div id="alerts"></div>
      <!-- Two columns when the panel is dragged wide (see panel.css); stacked otherwise. -->
      <div class="col">
        <div class="profile-row">
          <select id="profileSelect" class="profile-select" title="Profile"></select>
          <button class="icon secondary" id="refreshBtn" data-action="refresh" title="Refresh profiles and jobs">${I.refresh}</button>
        </div>
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
        <section class="card" id="qaCard" hidden></section>
      </div>
      <section class="card" id="previewCard" hidden></section>
    </main>`;
  $('#profileSelect').addEventListener('change', (e) => { setError(''); setMessage(''); selectProfile(e.target.value); });
  wireCombo();
  patchAlerts(); patchProfile(); patchJob(); patchBuild(); patchCopy(); patchQA();
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
  const box = (kind, cls, msg) => `<div class="alert ${cls}"><span>${esc(msg)}</span><button class="alert-x" data-action="dismissAlert" data-k="${kind}" title="Dismiss" aria-label="Dismiss">✕</button></div>`;
  el.innerHTML = (S.error ? box('error', 'error', S.error) : '') + (S.message ? box('message', 'ok', S.message) : '');
  el.hidden = !S.error && !S.message;
}

function patchProfile() {
  const sel = $('#profileSelect'); if (!sel) return;
  sel.innerHTML = S.profiles.length
    ? S.profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === S.profileId ? 'selected' : ''}>${esc(p.name)} · ${p.bid_count ?? 0} to bid</option>`).join('')
    : '<option>No profiles assigned to you</option>';
  patchLocks();
}

function patchCombo() {
  const list = $('#jobList'), input = $('#jobSearch'); if (!list) return;
  input.placeholder = S.queueLoading ? 'Loading jobs…' : `Search ${S.queue.length} job${S.queue.length === 1 ? '' : 's'} by company or title…`;
  patchLocks();
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
  // Reasons typed into an open Report / Skip box survive a re-render (e.g. a refresh).
  const reasons = {};
  for (const id of ['reportReason', 'skipReason']) { const t = $('#' + id); if (t?.value) reasons[id] = t.value; }
  const b = S.busy, spin = '<span class="spinner"></span>';
  // The copy-prompt / paste-JSON flow: always without ChatGPT; with it, on request or when it failed.
  const manual = !gptOn() || S.manual || currentThread()?.stage === 'failed';
  const score = S.atsScore;
  const tone = score >= 90 ? 'good' : score >= 75 ? 'mid' : 'low';
  el.innerHTML = `
    <div class="card-head"><span class="card-title">Resume</span>
      ${S.resumeId && score ? `<button class="ats-badge ${tone}" data-action="toggleAts" title="${S.ats ? 'How this score is calculated' : 'ATS score'}">ATS ${score}${S.ats ? (S.atsOpen ? ' ▴' : ' ▾') : ''}</button>` : ''}</div>
    <div id="gptLine"></div>
    ${S.resumeId ? `
      <button class="dl-btn" data-action="download" ${b ? 'disabled' : ''} title="Saves it straight to Downloads, replacing the previous file of the same name">${b === 'dl' ? spin : I.download} Download CV</button>
      <div class="muted small dl-hint">Saves “${esc(cvFilename())}” to Downloads — replaces the old one.</div>` : ''}
    ${manual ? `
      <div class="build-row two">
        <button class="grow" data-action="copyPrompt" ${b ? 'disabled' : ''}>${b === 'prompt' ? spin : I.sparkle} Copy GPT Prompt</button>
        <button class="grow" data-action="generate" ${b ? 'disabled' : ''}>${b === 'gen' ? spin : (S.resumeId ? 'Generate again' : 'Generate CV')}</button>
      </div>
      <textarea id="jsonInput" class="json" spellcheck="false" placeholder="Paste the JSON ChatGPT returned…"></textarea>
      ${gptOn() ? '<a href="#" class="small" data-action="manual">Hide the manual flow</a>' : ''}`
    : '<a href="#" class="small" data-action="manual">Write it by hand instead (copy prompt / paste JSON)</a>'}
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
        <div>Are you sure skip this job? Why doesn't it suit ${esc(selectedProfile()?.name || 'this profile')}?</div>
        <div class="chips">${SKIP_REASONS.map((r) => `<span class="chip" role="button" tabindex="0" data-action="skipReason" data-r="${esc(r)}">${esc(r)}</span>`).join('')}</div>
        <textarea id="skipReason" rows="2" placeholder="Pick a reason above or type one…"></textarea>
        <div class="row"><button class="warn grow" data-action="skipSubmit" ${b ? 'disabled' : ''}>${b === 'skip' ? spin : 'Skip job'}</button><button class="secondary grow" data-action="cancelConfirm">Cancel</button></div>
      </div>` : ''}`;
  if ($('#jsonInput')) $('#jsonInput').value = prev;
  patchGptLine();
  for (const [id, v] of Object.entries(reasons)) { const t = $('#' + id); if (t) t.value = v; }
  if (S.confirm === 'report' && !b && !reasons.reportReason) $('#reportReason')?.focus();
  if (S.confirm === 'skip' && !b && !reasons.skipReason) $('#skipReason')?.focus();
  patchPreview();
  patchLocks();
}

// The generated CV, previewed at the bottom of the panel (Chrome's PDF viewer, from
// the same fetched PDF that Download and Autofill use). Hide/Show is remembered.
let previewKey = '';
function patchPreview() {
  const el = $('#previewCard'); if (!el) return;
  const id = currentJob() ? S.resumeId : '';
  el.hidden = !id;
  const ready = !!id && pdfCache.id === id && !!pdfCache.url;
  const key = `${id}|${S.previewOpen}|${ready}`;
  if (key === previewKey) return;           // unchanged — don't reload the viewer
  previewKey = key;
  if (!id) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="card-head"><span class="card-title">CV preview</span>
      <button class="secondary sm-btn" data-action="togglePreview">${S.previewOpen ? 'Hide' : 'Show'}</button></div>
    ${!S.previewOpen ? '' : ready
      ? `<iframe class="pdf-frame" src="${pdfCache.url}#view=FitH&toolbar=0&navpanes=0" title="CV preview"></iframe>`
      : '<div class="empty"><span class="spinner"></span> Loading the CV…</div>'}`;
  if (S.previewOpen && !ready) {
    cvBlob(id).then(() => patchPreview()).catch((e) => {
      if (S.resumeId !== id) return;
      previewKey = '';
      el.innerHTML = `<div class="card-head"><span class="card-title">CV preview</span></div><div class="muted small">Couldn't load the CV — ${esc(e.message || 'try Download')}.</div>`;
    });
  }
}

// ---------- Autofill shortcut (manifest "commands": autofill) ----------
// Chrome owns the binding (users can change it at chrome://extensions/shortcuts);
// read it so the hint under the Autofill button is always the real key.
async function loadShortcut() {
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'autofill');
    S.shortcut = cmd?.shortcut || '';
  } catch { S.shortcut = ''; }
  patchCopy();
}
// The shortcut, pressed on a job page: the worker opens the panel if needed and
// asks it to autofill (see background.js). A message reaches an open panel; a panel
// it just opened finds the request in session storage when it boots.
const AUTOFILL_REQ = 'pendingAutofill';
async function takeAutofillRequest() {
  const { [AUTOFILL_REQ]: req } = await chrome.storage.session.get(AUTOFILL_REQ).catch(() => ({}));
  if (!req) return false;
  // With several windows open, only the panel of the window the key was pressed in acts.
  if (req.windowId != null && panelWindowId != null && req.windowId !== panelWindowId) return false;
  await chrome.storage.session.remove(AUTOFILL_REQ).catch(() => {});
  return Date.now() - req.at < 15000;
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'autofill' && S.screen === 'main' && availableModes().includes('bid')) {
    (async () => {
      if (S.mode !== 'bid') await setMode('bid');   // Autofill belongs to the Bid tab
      if (await takeAutofillRequest() && !S.fill.busy) await autofill({ fromShortcut: true });
    })().catch(showError);
  }
});

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
        <span class="kbd-hint">${S.shortcut === null ? '' : S.shortcut
          ? `<kbd title="Autofill shortcut — change it at chrome://extensions/shortcuts">${esc(S.shortcut)}</kbd>`
          : '<a href="#" data-action="setShortcut" title="Choose a key for Autofill">Set shortcut</a>'}</span>
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
  patchLocks();
}

// While a request for the current job is in flight (Generate, Mark as Applied, …) or Autofill /
// Remember runs, the job and profile can't change — the answer must land on the job it was for.
function patchLocks() {
  const locked = !!(S.busy || S.fill.busy);
  const js = $('#jobSearch'); if (js) js.disabled = !S.queue.length || locked;
  const ps = $('#profileSelect'); if (ps) ps.disabled = !S.profiles.length || locked;
}

// ---------- events ----------
async function onClick(e) {
  const t = e.target.closest('[data-action]'); if (!t) return;
  const a = t.dataset.action;
  try {
    switch (a) {
      case 'mode': if (t.dataset.mode !== S.mode) await setMode(t.dataset.mode); break;
      case 'gptConnect': await connectGpt(); break;
      case 'gptContinue': await gpt('continue'); break;
      case 'restartExt': chrome.runtime.reload(); break;
      case 'gptSignIn': await chrome.tabs.create({ url: 'https://chatgpt.com/auth/login' }); break;   // the user's own tab, to sign in
      case 'gptDisconnect': e.preventDefault(); await gpt('disconnect'); toast('ChatGPT disconnected'); break;
      case 'gptRetry': await api('/api/gpt/retry', { method: 'POST', body: { profile_id: S.profileId, job_id: S.jobId } }); await gpt('sync'); break;
      case 'manual': e.preventDefault(); S.manual = !S.manual; patchBuild(); break;
      case 'saveQuestions': await saveQuestions(); break;
      case 'copyAnswer': { const q = S.questions[Number(t.dataset.i)]; if (q) await copyText(answerFor(q), 'Answer'); break; }
      case 'copyAllAnswers': await copyText(S.questions.filter(answerFor).map((q) => `${q}\n${answerFor(q)}`).join('\n\n'), 'Answers'); break;
      case 'logout': showLogin(); break;
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
      case 'refresh': setError(''); setMessage(''); await refresh(); break;
      case 'dismissAlert': setAlert(t.dataset.k, ''); break;
      case 'togglePreview':
        S.previewOpen = !S.previewOpen;
        try { localStorage.setItem('panelPreviewOpen', S.previewOpen ? '1' : '0'); } catch { /* storage blocked */ }
        patchPreview(); break;
      case 'setShortcut': e.preventDefault(); await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); break;
      case 'skipReason': { const ta = $('#skipReason'); if (ta) { ta.value = t.dataset.r; ta.focus(); } break; }
      case 'autofill': await autofill(); break;
      case 'remember': await rememberAnswers(); break;
      case 'copyField': {
        const f = copyFields(selectedProfile())[Number(t.dataset.i)];
        if (f && await copyText(f[1], f[0])) { t.classList.add('copied'); setTimeout(() => t.classList.remove('copied'), 900); }
        break;
      }
    }
  } catch (err) { if (S.screen === 'main') showError(err); }
}

// Follow the shared session: signed in from another panel window → load;
// session cleared (expired / 401) → back to sign-in.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('token' in changes)) return;
  const authed = !!changes.token.newValue;
  if (authed && S.screen === 'login') boot();
  else if (!authed && (S.screen === 'main' || S.screen === 'noaccess')) showLogin();
});

// ---------- boot ----------
async function boot() {
  const { [JOB_TAB_KEY]: savedTab } = await chrome.storage.session.get(JOB_TAB_KEY).catch(() => ({}));
  if (savedTab != null) jobTabId = await chrome.tabs.get(savedTab).then((t) => t.id).catch(() => null);
  const cfg = await getConfig();
  S.user = cfg.user;
  if (!cfg.token) { S.screen = 'login'; renderLogin(); return; }
  await startMain();
}
boot();
