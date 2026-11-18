// LinkedIn classic job search, kept — merged from the "Classic Job Search Keeper" extension (v1.0.0),
// so bidders run ONE extension. When LinkedIn opens its AI job search (/jobs/search-results/,
// /jobs/search-job), the tab is sent back to the classic search (/jobs/search/?…&skipRedirect=true)
// with the bidder's last classic search filters. Runs in the service worker, panel open or not.
//
//   · The last classic search with filters is remembered by itself (chrome.storage.local).
//   · Never while an application form (Easy Apply) is open on the page — checked on the page itself
//     (a few tries, while LinkedIn loads). When the page can't be checked (no LinkedIn access granted,
//     still loading) the tab IS switched — like the original extension — unless a form was seen open
//     there in the last 2 minutes. (1.9 never switched without a definite "no form": with LinkedIn
//     access not granted, or a page still loading, classic search never came back.)
//   · Loop guard: LinkedIn may force AI search back; after 2 tries within 25 s the tab is left alone
//     for 10 minutes (the panel says so and offers "Try again").
// Kept from the original: the URL rules, the loop guard and the application check. Dropped: its popup
// (four switches, presets, manual URL paste, 15-minute pause) — one switch and "Open saved search" in
// the Easy Bids tab replace it — and its content script / webNavigation permission (tabs.onUpdated sees
// LinkedIn's in-page URL changes too, and a new permission would disable the extension on auto-update).

const HOST = 'www.linkedin.com';
const CLASSIC_PATH = /^\/jobs\/search\/?$/;
const AI_PATH = /^\/jobs\/(?:search-results|search-job)\/?$/;
export const CLASSIC_BASE = 'https://www.linkedin.com/jobs/search/';
const FIXED_KEYS = new Set(['keywords', 'location', 'geoId', 'distance', 'sortBy', 'start', 'f_TPR', 'f_WT', 'f_E', 'f_JT',
  'f_AL', 'f_C', 'f_JI', 'f_SB2', 'f_VJ', 'f_PP', 'f_I', 'f_F', 'f_T', 'spellCorrectionEnabled', 'origin']);
const OMIT_KEYS = new Set(['skipRedirect', 'currentJobId', 'trackingId', 'trk', 'refId', 'originalSubdomain', 'sessionRedirect',
  'position', 'lipi', 'midToken', 'midSig', 'redirectFrom', 'refresh']);

export const CLASSIC_ON = 'classicOn';          // the one switch (default on)
export const CLASSIC_SEARCH = 'classicSearch';  // the last classic search with filters
export const classicTabKey = (tabId) => `classic:tab:${tabId}`;   // per-tab loop guard (session storage)

const parse = (raw) => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === HOST && !u.port && !u.username && !u.password ? u : null;
  } catch { return null; }
};
export const isClassicSearch = (raw) => { const u = parse(raw); return !!u && CLASSIC_PATH.test(u.pathname); };
export const isAiSearch = (raw) => { const u = parse(raw); return !!u && AI_PATH.test(u.pathname); };
const isFilter = (key) => FIXED_KEYS.has(key) || /^f_[a-z0-9_]+$/i.test(key);
const filterCount = (raw) => { const u = parse(raw); return u ? [...u.searchParams.keys()].filter(isFilter).length : 0; };

// The classic search URL for a classic or AI search URL: its search filters only (never tracking ids,
// the open job or AI-only state), plus skipRedirect=true. null for any other page.
export function classicUrl(raw) {
  const u = parse(raw);
  if (!u || (!CLASSIC_PATH.test(u.pathname) && !AI_PATH.test(u.pathname))) return null;
  const target = new URL(CLASSIC_BASE);
  for (const [k, v] of u.searchParams) if (!OMIT_KEYS.has(k) && isFilter(k)) target.searchParams.append(k, v);
  target.searchParams.set('skipRedirect', 'true');
  return target.href;
}
// "python · Remote · 3 filters"
export function describeSearch(raw) {
  const u = parse(raw);
  if (!u) return '';
  const filters = new Set([...u.searchParams.keys()].filter((k) => k.startsWith('f_'))).size;
  return [u.searchParams.get('keywords') || 'All jobs', u.searchParams.get('location') || '', filters ? `${filters} filter${filters === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' · ');
}

// Injected into the LinkedIn tab: is a job application form open? Only looks for the dialog, never
// reads what is typed in it.
export function applicationOpenOnPage() {
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  if (visible(document.querySelector('.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"]'))) return true;
  for (const el of document.querySelectorAll('[role="dialog"], .artdeco-modal')) {
    if (!visible(el)) continue;
    const text = `${el.getAttribute('aria-label') || ''} ${el.querySelector('h1, h2, h3')?.textContent || ''}`;
    if (/apply|application|resume|candidature/i.test(text)) return true;
    if (el.querySelector('form') && el.querySelector('input[type="file"], button[aria-label*="Submit" i]')) return true;
  }
  return false;
}
// true / false, or null when the page can't be checked (no LinkedIn access, page loading) — tried a
// few times while LinkedIn finishes loading.
export async function applicationOpen(tabId, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: applicationOpenOnPage });
      if (typeof r?.result === 'boolean') return r.result;
    } catch { /* no access / not ready */ }
    if (i < tries - 1) await sleep(350);
  }
  return null;
}

const CHECK_DELAY_MS = 900;          // let LinkedIn settle (and any application dialog appear)
const ATTEMPT_WINDOW_MS = 25_000;
const MAX_ATTEMPTS = 2;
const BLOCK_MS = 10 * 60_000;
const APPLY_STALE_MS = 2 * 60_000;    // a form seen open this recently still counts when the page can't be checked
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function onUrl(tabId, url) {
  const u = parse(url);
  if (!u || !u.pathname.startsWith('/jobs')) return;
  const got = await chrome.storage.local.get([CLASSIC_ON, CLASSIC_SEARCH]);
  if (got[CLASSIC_ON] === false) return;
  if (isClassicSearch(url)) {                        // remember the bidder's classic search (with filters)
    const canonical = classicUrl(url);
    if (canonical && filterCount(url) > 0 && got[CLASSIC_SEARCH] !== canonical) await chrome.storage.local.set({ [CLASSIC_SEARCH]: canonical });
    return;
  }
  if (!isAiSearch(url)) return;
  await sleep(CHECK_DELAY_MS);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isAiSearch(tab.url)) return;
  const key = classicTabKey(tabId), now = Date.now();
  const state = (await chrome.storage.session.get(key))[key] || {};
  if ((state.blockedUntil || 0) > now) return;
  // Never throw away an application in progress.
  const applying = await applicationOpen(tabId);
  if (applying === true) { await chrome.storage.session.set({ [key]: { ...state, applyingAt: now } }); return; }
  if (applying === null && now - (state.applyingAt || 0) < APPLY_STALE_MS) return;
  const recent = (state.attempts || []).filter((t) => now - t < ATTEMPT_WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {               // LinkedIn keeps forcing AI search: stop, don't loop
    await chrome.storage.session.set({ [key]: { attempts: recent, blockedUntil: now + BLOCK_MS } });
    return;
  }
  if (recent.length && now - recent[recent.length - 1] < 650) return;   // the same change reported twice
  const saved = got[CLASSIC_SEARCH];
  const target = (isClassicSearch(saved) && filterCount(saved) > 0 && classicUrl(saved)) || classicUrl(tab.url) || `${CLASSIC_BASE}?skipRedirect=true`;
  if (target === tab.url) return;
  await chrome.storage.session.set({ [key]: { attempts: [...recent, now], blockedUntil: 0 } });
  await chrome.tabs.update(tabId, { url: target }).catch(() => {});
}

export function installClassicSearch() {
  const queues = new Map();   // one change at a time per tab, in order
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    // A new URL (a page load or LinkedIn's in-page navigation) — or a load of the SAME URL (a reload,
    // or LinkedIn bouncing the tab straight back to the AI search it was on), which carries no url.
    const url = change.url || (change.status === 'loading' ? tab?.url : '');
    if (!url || !/^https:\/\/www\.linkedin\.com\/jobs/i.test(url)) return;
    const next = (queues.get(tabId) || Promise.resolve()).then(() => onUrl(tabId, url)).catch(() => {});
    queues.set(tabId, next);
    next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); });
  });
  chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(classicTabKey(tabId)).catch(() => {}); });
}
