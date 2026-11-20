// Newest LinkedIn jobs, newest first — Easy Bids' "Newest Jobs" list.
//
// Why: since Oct 2026 LinkedIn sends signed-in members from the classic job search
// (/jobs/search/) to its AI search (/jobs/search-results/), which has no "Most recent" sort:
// sortBy=DD is stripped and any "Past X" window shorter than 24 h counts as 24 h. The classic
// search (and the Classic Job Search Keeper trick, ?skipRedirect=true) no longer comes back.
//
// What still works: LinkedIn's PUBLIC job list — what anyone sees at linkedin.com/jobs when signed
// out. It honours a window of any length in seconds (f_TPR=r900 → the last 15 minutes) and says how
// old each job is ("7 minutes ago"); it is not in date order, so the order is ours. It is read
// signed OUT (credentials: 'omit'): the bidder's LinkedIn account is never used for it. Only when the
// bidder asks (Refresh) or while the list is open with Auto on, a few pages at a time, slowly.
// Each row opens the posting (/jobs/view/<id>/) on the bidder's own LinkedIn tab, signed in, where
// Easy Bids reads it as usual.

export const RECENT_KEY = 'recentSearch';      // the bidder's search (chrome.storage.local)
export const RECENT_SEEN = 'recentOpened';     // job ids opened from the list (dimmed)
export const WINDOWS = [[900, '15 min'], [1800, '30 min'], [3600, '1 hour'], [7200, '2 hours'], [21600, '6 hours'], [86400, '24 hours']];
export const DEFAULT_SEARCH = { keywords: '', location: '', geoId: '', remote: true, easy: true, window: 3600, auto: true };

const GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const PAGE_GAP_MS = 700;        // between pages — gentle, like a person scrolling
export const MAX_PAGES = 10;    // ≤ 100 jobs per full refresh
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cleanSearch(s) {
  const o = { ...DEFAULT_SEARCH, ...(s || {}) };
  return {
    keywords: String(o.keywords || '').trim().slice(0, 200),
    location: String(o.location || '').trim().slice(0, 120),
    geoId: /^\d{1,12}$/.test(String(o.geoId || '')) ? String(o.geoId) : '',
    remote: !!o.remote, easy: !!o.easy, auto: !!o.auto,
    window: WINDOWS.some(([w]) => w === Number(o.window)) ? Number(o.window) : DEFAULT_SEARCH.window,
  };
}

// The search from a LinkedIn job search URL (classic or AI): keywords, place, Remote, Easy Apply.
export function searchFromUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname) || !/^\/jobs\//.test(u.pathname)) return null;
    const q = u.searchParams, wt = (q.get('f_WT') || '').split(',');
    if (!q.get('keywords') && !q.get('location') && !q.get('geoId')) return null;
    return { keywords: q.get('keywords') || '', location: q.get('location') || '', geoId: q.get('geoId') || '',
      remote: wt.includes('2'), easy: q.get('f_AL') === 'true' };
  } catch { return null; }
}

export function guestUrl(s, secs, start = 0) {
  const u = new URL(GUEST);
  if (s.keywords) u.searchParams.set('keywords', s.keywords);
  if (s.location) u.searchParams.set('location', s.location);
  if (s.geoId) u.searchParams.set('geoId', s.geoId);
  u.searchParams.set('f_TPR', `r${Math.max(60, Math.round(secs))}`);
  if (s.remote) u.searchParams.set('f_WT', '2');
  if (s.easy) u.searchParams.set('f_AL', 'true');
  u.searchParams.set('start', String(start));
  return u.href;
}

// "7 minutes ago" → 7; "2 hours ago" → 120; "Just now" → 0. null when there's no age in it.
export function ageMinutes(text) {
  const t = String(text || '').toLowerCase();
  if (/just now|moments? ago|now$/.test(t)) return 0;
  const m = t.match(/(\d+)\s*(second|sec|minute|min|hour|hr|day|week|month)/);
  if (!m) return null;
  const n = Number(m[1]);
  return { second: 0, sec: 0, minute: 1, min: 1, hour: 60, hr: 60, day: 1440, week: 10080, month: 43200 }[m[2]] * n;
}

const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
// The public list's cards → jobs. `now` stamps each job's posting time (now − its age).
export function parseCards(html, now = Date.now()) {
  const doc = new DOMParser().parseFromString(`<ul>${html}</ul>`, 'text/html');
  const out = [];
  for (const card of doc.querySelectorAll('[data-entity-urn*="jobPosting:"], .base-search-card')) {
    const id = ((card.getAttribute('data-entity-urn') || '').match(/jobPosting:(\d+)/)
      || (card.querySelector('a[href*="/jobs/view/"]')?.getAttribute('href') || '').match(/-(\d{6,})(?:[/?]|$)/)
      || (card.querySelector('[data-entity-urn*="jobPosting:"]')?.getAttribute('data-entity-urn') || '').match(/jobPosting:(\d+)/) || [])[1];
    if (!id || out.some((j) => j.id === id)) continue;
    const time = card.querySelector('time');
    const ageText = txt(time);
    let mins = ageMinutes(ageText);
    if (mins == null) {   // no "N ago": the date alone (start of that day)
      const d = Date.parse(time?.getAttribute('datetime') || '');
      mins = Number.isFinite(d) ? Math.max(0, Math.round((now - d) / 60000)) : 24 * 60;
    }
    out.push({
      id,
      title: txt(card.querySelector('.base-search-card__title')) || 'Untitled job',
      company: txt(card.querySelector('.base-search-card__subtitle')),
      location: txt(card.querySelector('.job-search-card__location')),
      salary: txt(card.querySelector('.job-search-card__salary-info')),
      note: txt(card.querySelector('.job-posting-benefits__text')),
      postedAt: now - mins * 60000,
    });
  }
  return out;
}

export class LimitedError extends Error {}

// Newest jobs posted within `secs`, newest first: the public list, page by page (10 a page), until a
// page is empty or `maxPages`. Throws LimitedError when LinkedIn asks to slow down (HTTP 429).
export async function fetchNewest(search, { secs, maxPages = MAX_PAGES, signal } = {}) {
  const s = cleanSearch(search), seen = new Map();
  for (let page = 0; page < maxPages; page++) {
    if (page) await sleep(PAGE_GAP_MS);
    if (signal?.aborted) break;
    const res = await fetch(guestUrl(s, secs || s.window, page * 10), { credentials: 'omit', cache: 'no-store', signal });
    if (res.status === 429 || res.status === 999) throw new LimitedError('LinkedIn asked to slow down');
    if (res.status === 400 || res.status === 404) break;   // past the last page
    if (!res.ok) throw new Error(`LinkedIn answered ${res.status}`);
    const cards = parseCards(await res.text());
    const before = seen.size;
    for (const j of cards) if (!seen.has(j.id)) seen.set(j.id, j);
    if (!cards.length || seen.size === before) break;      // empty, or the same page again
  }
  return sortNewest([...seen.values()]);
}

// Newest first; the same minute → the higher (newer) LinkedIn id first.
export const sortNewest = (jobs) => jobs.sort((a, b) => (b.postedAt - a.postedAt) || (b.id.length - a.id.length) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));

// "now", "7m", "2h 5m", "3h", "1d"
export function ago(postedAt, now = Date.now()) {
  const m = Math.max(0, Math.round((now - postedAt) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 180) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

// The same company + title posted for many places (staffing firms post one job per city): one row —
// the newest, with the others in `others` (TailorResume takes one job per company anyway).
export function groupSame(jobs) {
  const by = new Map(), out = [];
  for (const j of jobs) {
    const k = `${j.company.toLowerCase()}|${j.title.toLowerCase()}`;
    const g = by.get(k);
    if (g) g.others.push(j);
    else { const row = { ...j, others: [] }; by.set(k, row); out.push(row); }
  }
  return out;
}
