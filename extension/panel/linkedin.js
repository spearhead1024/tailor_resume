/* LinkedIn job reader for the Easy Bids tab.
 *
 * linkedinJobId(url) — the LinkedIn job a tab URL points at ('' if none): the job view page
 *   (/jobs/view/<id>, or a slug ending in -<id>) or a search / collection page showing one in its
 *   right-hand pane (?currentJobId=<id>). The same rule as the server's core/easy_apply.py.
 *
 * readLinkedInJob(wantId) is injected into the LinkedIn tab with chrome.scripting, so it is fully
 * self-contained. LinkedIn is a single-page app: after a click the URL changes first and the
 * detail pane catches up a moment later, so it waits (up to ~12 s) until the pane shows THAT job —
 * its apply button / title link carry the job id — with a title, company and description loaded.
 * Returns { id, title, company, location, description, apply, ready } where apply is:
 *   'easy'     — an "Easy Apply" button: the only kind Easy Bids takes
 *   'external' — "Apply" on the company's own site
 *   'applied'  — already applied on LinkedIn (no button, "Applied … ago")
 *   'closed'   — "No longer accepting applications"
 *   'none'     — no apply button found
 * Selectors follow LinkedIn's job-details markup (the logged-in job search page, Nov 2026), with older ones
 * as fallbacks. */

export function linkedinJobId(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return '';
  const view = (u.pathname + '/').match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})\//i);
  if (view) return view[1];
  const cur = u.searchParams.get('currentJobId') || '';
  return /^\d{6,}$/.test(cur) ? cur : '';
}

export async function readLinkedInJob(wantId) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const oneLine = (s) => clean(s).replace(/\s+/g, ' ');
  const textOf = (el) => {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('script,style,noscript,button,svg,[aria-hidden="true"],.visually-hidden').forEach((n) => n.remove());
    c.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    c.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,section,article,ul,ol').forEach((n) => { n.prepend('\n'); n.append('\n'); });
    c.querySelectorAll('li').forEach((n) => { n.prepend('\n• '); n.append('\n'); });
    return clean(c.textContent);
  };
  const pick = (root, sels) => { for (const s of sels) { const el = root.querySelector(s); if (el && oneLine(el.textContent)) return el; } return null; };
  const idIn = (href) => (String(href || '').match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/) || [])[1] || '';

  const read = () => {
    // The detail pane (search page) or the whole page (a /jobs/view/ page).
    const root = document.querySelector('.jobs-search__job-details--container, .jobs-search__job-details, .job-view-layout, .jobs-details') || document;
    const titleEl = pick(root, ['.job-details-jobs-unified-top-card__job-title h1', '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title', '.top-card-layout__title', 'h1']);
    const companyEl = pick(root, ['.job-details-jobs-unified-top-card__company-name a', '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name a', '.jobs-unified-top-card__company-name', '.topcard__org-name-link']);
    // The apply control: a button today (#jobs-apply-button-id, data-job-id); any element labelled like one as a fallback.
    const btn = root.querySelector('button.jobs-apply-button, #jobs-apply-button-id, .jobs-apply-button--top-card button, .jobs-s-apply button')
      || root.querySelector('[aria-label^="Easy Apply"], [aria-label*="on company website"]');
    const titleLink = root.querySelector('.job-details-jobs-unified-top-card__job-title a[href*="/jobs/view/"], .jobs-unified-top-card__job-title a[href*="/jobs/view/"]');
    const onView = idIn(location.pathname);
    const id = (btn && btn.getAttribute('data-job-id')) || idIn(titleLink && titleLink.getAttribute('href')) || onView || '';
    const descEl = root.querySelector('#job-details, .jobs-description__content, .jobs-description-content__text, .jobs-box__html-content, .show-more-less-html__markup');
    const description = textOf(descEl).replace(/^About the job\s*/i, '').trim();
    const locEl = root.querySelector('.job-details-jobs-unified-top-card__tertiary-description-container .tvm__text, .job-details-jobs-unified-top-card__primary-description-container .tvm__text, .jobs-unified-top-card__bullet');
    let apply = 'none';
    if (btn) {
      const label = `${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''}`;
      apply = /easy\s*apply/i.test(label) ? 'easy' : 'external';
    } else {
      const status = oneLine((root.querySelector('.jobs-s-apply, .jobs-apply-button--top-card, .artdeco-inline-feedback, .jobs-details-top-card__apply-error') || {}).textContent);
      if (/no longer accepting/i.test(status) || /no longer accepting applications/i.test(oneLine(root.textContent).slice(0, 4000))) apply = 'closed';
      else if (/\bapplied\b/i.test(status)) apply = 'applied';
    }
    return {
      id, apply,
      title: oneLine(titleEl && titleEl.textContent),
      company: oneLine(companyEl && companyEl.textContent),
      location: oneLine(locEl && locEl.textContent),
      description: description.length > 20000 ? `${description.slice(0, 20000)}\n…` : description,
    };
  };

  let last = null;
  for (let i = 0; i < 40; i++) {                    // ~12 s
    last = read();
    const sameJob = !wantId || last.id === wantId;
    // Once the pane shows the job, the apply area may render a beat after the text.
    if (sameJob && last.title && last.company && last.description.length >= 100 && (last.apply !== 'none' || i >= 6)) {
      return { ...last, ready: true };
    }
    await sleep(300);
  }
  return { ...(last || {}), ready: false };
}

// Injected into the LinkedIn tab: the company's own apply link of an outside-apply posting ('' if it
// can't be read). No click, no tab:
//   1. a link on the page that carries it — LinkedIn's redirect /jobs/view/externalApply/…?url=<link>
//   2. the posting's data from LinkedIn's own API (the request its job page makes, with the signed-in
//      session's CSRF token) — its applyMethod holds companyApplyUrl, wherever the format puts it.
// (When both fail, the panel catches the tab LinkedIn's "Apply" button opens — the bidder's click.)
export async function readOutsideLink(jobId) {
  const external = (u) => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) && !/(^|\.)linkedin\.com$/i.test(x.hostname) ? x.href : ''; } catch { return ''; } };
  for (const a of document.querySelectorAll('a[href*="externalApply"], a[href*="url="]')) {
    try {
      const u = new URL(a.getAttribute('href'), location.href);
      const hit = external(u.searchParams.get('url') || '');
      if (hit) return hit;
    } catch { /* not a URL */ }
  }
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] || '';
  const find = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 12) return '';
    for (const [k, v] of Object.entries(node)) {
      if (k === 'companyApplyUrl' && typeof v === 'string' && external(v)) return external(v);
      const hit = find(v, depth + 1); if (hit) return hit;
    }
    return '';
  };
  for (const path of [`/voyager/api/jobs/jobPostings/${jobId}`, `/voyager/api/jobs/jobPostings/${jobId}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`]) {
    try {
      const res = await fetch(path, { credentials: 'include', headers: { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', accept: 'application/json' } });
      if (!res.ok) continue;
      const hit = find(await res.json());
      if (hit) return hit;
    } catch { /* blocked / changed — the click fallback takes over */ }
  }
  return '';
}
