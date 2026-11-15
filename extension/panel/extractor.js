/* Page extractor for the Add job tab (ported from VPS1's Job Adder extension).
 *
 * extractJobFromPage() is injected into the ACTIVE TAB with chrome.scripting
 * (site access, on the user's click), so it must be fully
 * self-contained: no references to anything outside the function. It returns a
 * plain object { link, company, title, description, source } where `source`
 * names the strategy that produced each field, for the panel to show.
 * (Region is NOT read from the page — the adder picks it; guessing it was unreliable.)
 *
 * Strategy order (most to least reliable):
 *   1. JSON-LD  <script type="application/ld+json"> with @type JobPosting
 *   2. Known job boards / ATS DOM selectors
 *   3. Open Graph / meta tags
 *   4. Generic: <h1>, canonical URL, main content block
 */
export function extractJobFromPage() {
  const clean = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const htmlToText = (html) => {
    const div = document.createElement('div')
    div.innerHTML = String(html || '')
    div.querySelectorAll('script,style,noscript').forEach((n) => n.remove())
    div.querySelectorAll('br').forEach((n) => n.replaceWith('\n'))
    div.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,tr,section,article,ul,ol').forEach((n) => { n.prepend('\n'); n.append('\n') })
    div.querySelectorAll('li').forEach((n) => { n.prepend('\n• '); n.append('\n') })
    return clean(div.textContent)
  }
  const nodeText = (el) => {
    if (!el) return ''
    const c = el.cloneNode(true)
    c.querySelectorAll('script,style,noscript,button,input,select,textarea,svg,nav,header,footer,[aria-hidden="true"]').forEach((n) => n.remove())
    return htmlToText(c.innerHTML)
  }
  const meta = (sel) => { const el = document.querySelector(sel); return clean(el ? (el.getAttribute('content') || el.getAttribute('href') || '') : '') }
  const q = (sel) => { try { return document.querySelector(sel) } catch { return null } }
  const first = (...sels) => { for (const s of sels) { const el = q(s); const t = nodeText(el); if (t) return t } return '' }
  const out = { link: '', company: '', title: '', description: '', source: {} }
  const set = (k, v, src) => { v = clean(v); if (v && !out[k]) { out[k] = v; out.source[k] = src } }

  // --- 1. JSON-LD JobPosting
  try {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    const seen = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      const t = node['@type']
      const types = Array.isArray(t) ? t : [t]
      if (types.some((x) => String(x || '').toLowerCase() === 'jobposting')) seen.push(node)
      if (node['@graph']) walk(node['@graph'])
      if (node.mainEntity) walk(node.mainEntity)
    }
    for (const s of scripts) { try { walk(JSON.parse(s.textContent || '')) } catch { /* ignore malformed */ } }
    const jp = seen[0]
    if (jp) {
      set('title', jp.title || jp.name, 'json-ld')
      const org = jp.hiringOrganization
      set('company', org && (typeof org === 'string' ? org : org.name || org.legalName), 'json-ld')
      set('description', jp.description && (/<[a-z][\s\S]*>/i.test(jp.description) ? htmlToText(jp.description) : jp.description), 'json-ld')
      set('link', jp.url || (jp.mainEntityOfPage && (jp.mainEntityOfPage['@id'] || jp.mainEntityOfPage)), 'json-ld')
    }
  } catch { /* fall through */ }

  // --- 2. Known boards / ATS
  const host = location.hostname.replace(/^www\./, '')
  const boards = [
    { m: /linkedin\.com/, title: ['.top-card-layout__title', 'h1.topcard__title', '.job-details-jobs-unified-top-card__job-title h1', 'h1'], company: ['.topcard__org-name-link', '.top-card-layout__card a[data-tracking-control-name*="topcard-org-name"]', '.job-details-jobs-unified-top-card__company-name a', '.job-details-jobs-unified-top-card__company-name'], desc: ['.show-more-less-html__markup', '#job-details', '.jobs-description__content', '.description__text'] },
    { m: /greenhouse\.io/, title: ['.app-title', 'h1.section-header', '.job__title h1', 'h1'], company: ['.company-name', '#header .company-name', 'span.company-name', '.job__company', 'meta[property="og:site_name"]'], desc: ['.job__description', '#content', '[class*="job__description"]', '#app_body', 'main'] },
    { m: /lever\.co/, title: ['.posting-headline h2', 'h2'], company: ['.main-header-logo img[alt]', '.posting-headline .posting-categories .company'], desc: ['.posting-page .section-wrapper', '[data-qa="job-description"]', '.content'] },
    { m: /ashbyhq\.com/, title: ['h1', '[class*="jobPosting"] h1'], company: ['[class*="companyName"]', 'header a[href="/"]', 'title'], desc: ['[class*="jobPosting"] [class*="description"]', '[class*="description"]', 'main'] },
    { m: /workable\.com/, title: ['h1[data-ui="job-title"]', 'h1'], company: ['[data-ui="company-name"]', 'a[data-ui="company-name"]'], desc: ['[data-ui="job-description"]', '[data-ui="job-requirements"]', 'main'] },
    { m: /indeed\.com/, title: ['h1.jobsearch-JobInfoHeader-title', 'h1'], company: ['[data-company-name="true"]', '[data-testid="inlineHeader-companyName"]', '.jobsearch-InlineCompanyRating div'], desc: ['#jobDescriptionText'] },
    { m: /glassdoor\./, title: ['h1[data-test="job-title"]', 'h1'], company: ['[data-test="employer-name"]', '.EmployerProfile_employerName__Xemli'], desc: ['[class*="JobDetails_jobDescription"]', '#JobDescriptionContainer'] },
    { m: /wellfound\.com|angel\.co/, title: ['h1'], company: ['a[href^="/company/"] h2', 'a[href^="/company/"]'], desc: ['#job-description', '[class*="description"]'] },
    { m: /remoteok\.com|remoteok\.io/, title: ['h2[itemprop="title"]', 'h1'], company: ['h3[itemprop="name"]', '[itemprop="hiringOrganization"]'], desc: ['.description', '[itemprop="description"]'] },
    { m: /weworkremotely\.com/, title: ['.listing-header-container h1', 'h1'], company: ['.listing-header-container .company', '.company-card h2'], desc: ['.listing-container', '#job-listing-show-container'] },
    { m: /jobs\.smartrecruiters\.com/, title: ['h1.job-title', 'h1'], company: ['.job-company-name', '[itemprop="hiringOrganization"]'], desc: ['#st-jobDescription', '.job-sections'] },
    { m: /myworkdayjobs\.com/, title: ['h2[data-automation-id="jobPostingHeader"]', 'h1'], company: ['title'], desc: ['[data-automation-id="jobPostingDescription"]'] },
    { m: /bamboohr\.com/, title: ['h2.js-jobs-title', 'h1'], company: ['.js-company-name', 'title'], desc: ['.js-jobs-description', '#jobDescription'] },
    { m: /jobvite\.com/, title: ['.jv-header', 'h1'], company: ['.jv-logo img[alt]', 'title'], desc: ['.jv-job-detail-description'] },
    { m: /icims\.com/, title: ['.iCIMS_Header h1', 'h1'], company: ['title'], desc: ['.iCIMS_JobContent', '.iCIMS_InfoMsg_Job'] },
    { m: /remotive\.com|remotive\.io/, title: ['h1'], company: ['.company-name', '[class*="company"]'], desc: ['.job-description', '[class*="description"]'] },
    { m: /careers-page\.com|recruitee\.com|personio\.de|join\.com|teamtailor\.com|breezy\.hr/, title: ['h1'], company: ['title'], desc: ['main', 'article', '[class*="description"]', '[class*="content"]'] },
  ]
  const board = boards.find((b) => b.m.test(host))
  if (board) {
    const alt = (sels) => { for (const s of sels) { const el = q(s); if (!el) continue; const t = clean(el.getAttribute && el.getAttribute('alt')) || nodeText(el); if (t) return t } return '' }
    set('title', first(...board.title), host)
    set('company', alt(board.company), host)
    set('description', first(...board.desc), host)
  }

  // --- 3. Open Graph / meta
  set('title', meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]'), 'meta')
  set('company', meta('meta[property="og:site_name"]'), 'meta')
  set('link', meta('link[rel="canonical"]') || meta('meta[property="og:url"]'), 'meta')

  // --- 4. Generic fallbacks
  set('title', nodeText(q('h1')) || clean(document.title.split(/[|–-]/)[0]), 'page')
  set('link', location.href, 'page')
  if (!out.description) {
    const candidates = Array.from(document.querySelectorAll('[class*="description" i], [id*="description" i], article, main, [role="main"], .content, #content'))
    let best = ''
    for (const el of candidates) { const t = nodeText(el); if (t.length > best.length) best = t }
    if (best.length < 200) best = nodeText(document.body)
    set('description', best, 'page')
  }
  if (!out.company) {
    // Company from "Title at Company" / "Title - Company" patterns, else the site name.
    const dt = clean(document.title)
    const m = dt.match(/\b(?:at|@)\s+([^|–\-]{2,60})$/i) || dt.match(/[|–-]\s*([^|–-]{2,60})$/)
    const slug = (new URLSearchParams(location.search).get('for') || (host.match(/^(?:boards|job-boards)\.greenhouse\.io$/) ? location.pathname.split('/').filter(Boolean)[0] : '') || '')
    set('company', m ? m[1] : (slug ? slug.replace(/[-_]+/g, ' ') : host.split('.').slice(-2, -1)[0]), 'page')
  }
  // Company titles like "Acme Careers" / "Jobs at Acme" -> "Acme"
  out.company = clean(out.company.replace(/^(?:jobs?|careers?)\s+(?:at|@)\s+/i, '').replace(/\s+[-|–]?\s*(?:careers?|jobs?)\s*$/i, ''))
  // Keep the description to a sane size for the form.
  if (out.description.length > 20000) out.description = out.description.slice(0, 20000) + '\n…'
  return out
}
