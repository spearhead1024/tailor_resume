// TailorResume floating card — a small, draggable popup injected into every
// page (isolated Shadow DOM). All auth/API/screenshot work goes via the worker.

(() => {
  if (window.__tailorResumeBar) return;
  window.__tailorResumeBar = true;

  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
  const PROFILE_KEY = 'tr_selected_profile';
  const POS_KEY = 'tr_pos';
  const MIN_KEY = 'tr_min';
  const BINDINGS_KEY = 'tr_bindings';
  // NOTE: visibility is intentionally NOT persisted. The card defaults to
  // visible on every fresh page load; closing it (✕ / toggle) only hides it for
  // the current page. A global persisted "hidden" flag previously made the card
  // stay invisible on every site after one close — looking like it never loaded.

  // Whether this content script is running in the top document. The card,
  // session, and job match all live in the top frame; sub-frames (cross-origin
  // ATS form iframes) run a slim keyboard-paste path only (see bottom).
  const IS_TOP = (() => { try { return window.top === window; } catch { return false; } })();

  // ── Web-app bridge ────────────────────────────────────────────────────
  // Let the TailorResume web app open many job tabs in one click. The page
  // itself can't (the pop-up blocker caps it at one tab); we have the "tabs"
  // permission, so we open them via the worker. Only exposed on the app origin.
  const APP_ORIGIN_RE = /^https?:\/\/(tailorresume\.duckdns\.org|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/i;
  if (IS_TOP && APP_ORIGIN_RE.test(location.origin)) {
    // Tag the page so the app can detect the extension (isolated worlds share
    // the DOM but not JS globals, so we signal via a DOM attribute).
    try { document.documentElement.setAttribute('data-tailorresume-ext', chrome.runtime.getManifest().version); } catch { /* */ }
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const d = e.data;
      if (!d || d.__tailorresume !== 'open-tabs' || !Array.isArray(d.urls)) return;
      const urls = d.urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 60);
      if (urls.length) send({ type: 'openTabs', urls });
    });
  }

  // helpers --------------------------------------------------------------
  function linkedinUrl(v) {
    v = (v || '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    const rest = v.replace(/^www\./i, '').replace(/^linkedin\.com\/?/i, '').replace(/^\/+/, '');
    return `https://www.linkedin.com/${rest}`;
  }
  const splitName = (name) => {
    const parts = (name || '').trim().split(/\s+/);
    return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
  };
  const eduText = (p) => (p.education_history || [])
    .map((e) => [e.university, e.degree, e.duration].filter(Boolean).join(' | ')).join('\n');
  const workText = (w) => [w.company_name, w.role_title || w.role, w.duration, w.location].filter(Boolean).join(' | ');

  // Copy/paste fields. `id` matches the server's shortcut catalog; the actual
  // key comes from state.bindings (user-customizable in Help → Shortcuts).
  const COPY_FIELDS = [
    { id: 'first',      ico: '👤', lbl: 'First',     get: (p) => splitName(p.name).first },
    { id: 'last',       ico: '👤', lbl: 'Last',      get: (p) => splitName(p.name).last },
    { id: 'full',       ico: '🪪', lbl: 'Full Name', get: (p) => p.name },
    { id: 'email',      ico: '✉️', lbl: 'Email',     get: (p) => p.email },
    { id: 'phone',      ico: '📞', lbl: 'Phone',     get: (p) => p.phone },
    { id: 'location',   ico: '📍', lbl: 'Location',  get: (p) => p.location },
    { id: 'address',    ico: '🏠', lbl: 'Address',   get: (p) => p.address },
    { id: 'zip',        ico: '🏷️', lbl: 'Zip',       get: (p) => p.zip_code },
    { id: 'linkedin',   ico: '🔗', lbl: 'LinkedIn',  get: (p) => linkedinUrl(p.linkedin) },
    { id: 'github',     ico: '🐙', lbl: 'Github',    get: (p) => p.github },
    { id: 'portfolio',  ico: '🌐', lbl: 'Portfolio', get: (p) => p.portfolio },
    { id: 'university', ico: '🎓', lbl: 'University',get: (p) => eduText(p) },
    { id: 'exp1',       ico: '🏢', lbl: 'Exp 1',     get: (p) => workText((p.work_history || [])[0] || {}) },
    { id: 'exp2',       ico: '🏢', lbl: 'Exp 2',     get: (p) => workText((p.work_history || [])[1] || {}) },
    { id: 'exp3',       ico: '🏢', lbl: 'Exp 3',     get: (p) => workText((p.work_history || [])[2] || {}) },
    { id: 'exp4',       ico: '🏢', lbl: 'Exp 4',     get: (p) => workText((p.work_history || [])[3] || {}) },
  ];

  // action id → default key (mirrors the backend SHORTCUT_DEFAULTS). The
  // modifier is always Alt; each key is a single [a-z0-9].
  const DEFAULT_BINDINGS = {
    toggle: 'a', download: 'd', report: 'r', screenshot: 's',
    first: 'f', last: 'l', full: 'n', email: 'e', phone: 'p', location: 'o',
    address: 'b', zip: 'z', linkedin: 'i', github: 'g', portfolio: 't',
    university: 'u', exp1: '1', exp2: '2', exp3: '3', exp4: '4',
  };
  const skLabel = (k) => `⌥${String(k || '').toUpperCase()}`;
  const bindKey = (id) => state.bindings[id] || DEFAULT_BINDINGS[id] || '';
  const actionForKey = (k) => {
    for (const id in state.bindings) if (state.bindings[id] === k) return id;
    return null;
  };
  // Resolve the PHYSICAL key from a keydown, independent of layout/modifiers.
  // Keying off e.key breaks on macOS, where Option(Alt)+letter yields composed
  // or dead-key characters (Alt+L→'¬', Alt+E→dead) that never match [a-z0-9].
  const codeToKey = (code) => {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    return '';
  };
  const COPY_IDS = new Set(COPY_FIELDS.map((f) => f.id));

  const state = {
    authed: false, profiles: [], profileId: '',
    match: null, downloaded: false, update: null,
    screenshotDone: false, applied: false,
    bindings: { ...DEFAULT_BINDINGS },
    host: null, root: null, card: null, lastUrl: location.href,
  };
  // Did the matched resume already get applied (e.g. via the Apply tab)?
  const matchApplied = (mm) => !!(mm && mm.resume && mm.resume.applied_status === 'applied');

  // chrome.downloads rejects path separators and a handful of other chars.
  function sanitizeFilename(name) {
    return String(name || '').replace(/[\/\\:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
  }

  async function copy(text) {
    if (!text) return false;
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); return true;
      } catch { return false; }
    }
  }

  // The real focused element, descending into open shadow roots.
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  // Insert text into the page's focused input/textarea/contenteditable at the
  // caret (used by the keyboard shortcuts — "paste", not clipboard copy).
  // Returns false if nothing editable is focused so callers can fall back.
  function pasteIntoField(value) {
    const ae = deepActive();
    if (!ae || ae === state.host) return false;               // ignore our own card
    const tag = ae.tagName;
    const editable = ae.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA';
    if (!editable) return false;
    ae.focus();
    // execCommand keeps native undo and fires the input events frameworks need.
    try { if (document.execCommand('insertText', false, value)) return true; } catch { /* */ }
    // Fallback for inputs/textareas: native value setter + input/change events.
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      const start = ae.selectionStart == null ? ae.value.length : ae.selectionStart;
      const end = ae.selectionEnd == null ? ae.value.length : ae.selectionEnd;
      const next = ae.value.slice(0, start) + value + ae.value.slice(end);
      if (setter) setter.call(ae, next); else ae.value = next;
      const pos = start + value.length;
      try { ae.setSelectionRange(pos, pos); } catch { /* */ }
      ae.dispatchEvent(new Event('input', { bubbles: true }));
      ae.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  // Sub-frames (cross-origin ATS application iframes) run ONLY the keyboard
  // path: a keydown there never bubbles to the top frame, so without this the
  // shortcuts couldn't paste into embedded form fields. The frame has no card
  // or session, so it resolves values/actions through the worker (which keeps
  // per-tab context the top frame pushes).
  if (!IS_TOP) { setupSubframeShortcuts(); return; }

  function setupSubframeShortcuts() {
    let bindings = { ...DEFAULT_BINDINGS };
    const refresh = () => send({ type: 'shortcuts' }).then((r) => {
      if (r && r.ok && r.bindings) bindings = { ...DEFAULT_BINDINGS, ...r.bindings };
    });
    // Seed from the last-known-good cache so a failed fetch keeps custom keys.
    chrome.storage.local.get(BINDINGS_KEY).then((s) => {
      if (s && s[BINDINGS_KEY]) bindings = { ...DEFAULT_BINDINGS, ...s[BINDINGS_KEY] };
    });
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('keydown', async (e) => {
      if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const k = codeToKey(e.code);
      if (!k) return;
      let action = null;
      for (const id in bindings) if (bindings[id] === k) { action = id; break; }
      if (!action) return;
      if (!COPY_IDS.has(action)) {
        // toggle/download/report/screenshot belong to the top frame.
        e.preventDefault(); e.stopPropagation();
        send({ type: 'frameAction', action });
        return;
      }
      e.preventDefault(); e.stopPropagation();
      const r = await send({ type: 'getPasteValue', actionId: action });
      if (r && r.ok && r.downloaded && r.value) pasteIntoField(r.value);
    }, true);
  }

  function toast(text, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`; t.textContent = text;
    state.root.appendChild(t);
    setTimeout(() => t.remove(), 1700);
  }
  // Never assigns innerHTML — the 4th arg is plain TEXT. This keeps the card
  // working on pages that enforce Trusted Types (Workday/iCIMS/etc., where any
  // innerHTML write throws and would abort rendering, leaving no card).
  function el(tag, cls, attrs, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }
  const selectedProfile = () => state.profiles.find((x) => x.id === state.profileId);

  // Apply the card's CSS in a way the page's CSP can't block. We inline the
  // stylesheet (fetched by the worker) via a constructable stylesheet — no DOM
  // <link>/<style> node, so strict style-src CSP can't strip the card's styles
  // and leave it invisible. Falls back to <style>, then <link>.
  async function applyStyles(root) {
    let css = '';
    try { const r = await send({ type: 'getCss' }); if (r && r.ok) css = r.css || ''; } catch { /* */ }
    if (css && 'adoptedStyleSheets' in Document.prototype) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        return;
      } catch { /* fall through */ }
    }
    if (css) {
      const style = document.createElement('style');
      style.textContent = css;
      root.appendChild(style);
      return;
    }
    // Last resort (may be blocked by strict CSP).
    const link = el('link', null, { rel: 'stylesheet', href: chrome.runtime.getURL('content/bar.css') });
    root.appendChild(link);
  }

  // Critical layout applied as an INLINE style on the card. Inline styles set
  // via CSSOM are never subject to the page's CSP, so the card is positioned and
  // visible even before (or without) the full stylesheet. The full bar.css then
  // refines colors/spacing. This is the guarantee that the card "appears" on
  // strict-CSP sites (Greenhouse, Workday, etc.).
  const CRITICAL_CARD_CSS =
    'position:fixed;z-index:2147483647;width:340px;background:#0b1626;color:#e6edf6;' +
    'border:1px solid #1e2d44;border-radius:14px;box-shadow:0 12px 34px rgba(0,0,0,.55);' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;' +
    'font-size:13px;overflow:hidden;';

  // mount ----------------------------------------------------------------
  async function mount() {
    const host = el('div'); host.id = 'tailorresume-card-host'; host.style.cssText = 'all:initial';
    (document.documentElement || document.body).appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const card = el('div', 'tr-card'); card.style.cssText = CRITICAL_CARD_CSS;
    root.appendChild(card);
    state.host = host; state.root = root; state.card = card;

    const store = await chrome.storage.local.get([POS_KEY, MIN_KEY]);
    const pos = store[POS_KEY] || { left: Math.max(12, window.innerWidth - 360), top: 16 };
    // Clamp the restored position into the current viewport (a stale position,
    // or a small/embedded viewport, could otherwise place the card off-screen).
    const left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - 340));
    const top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - 40));
    card.style.left = `${left}px`; card.style.top = `${top}px`;
    if (store[MIN_KEY]) card.classList.add('min');
    host.style.display = 'block';   // visible by default on every page
    render();
    applyStyles(root);   // non-blocking — enhances the inline critical styles
    // Honor a show/toggle command that arrived while we were still mounting
    // (e.g. the popup injected us just now).
    if (pendingShow) { pendingShow = pendingToggle = false; showCard(); }
    else if (pendingToggle) { pendingToggle = false; toggleVisible(); }
  }

  // render ---------------------------------------------------------------
  function render() {
    const card = state.card; card.replaceChildren();   // clear without innerHTML

    // title bar (drag handle)
    const title = el('div', 'tr-title');
    const brand = el('div', 'tr-brand'); brand.append('Tailor', el('b', null, null, 'Resume'));
    title.appendChild(brand);
    title.appendChild(el('div', 'sp'));
    const move = el('button', 'tr-winbtn', { title: 'Drag to move' }, '✛');
    const min = el('button', 'tr-winbtn', { title: 'Minimize' }, card.classList.contains('min') ? '▢' : '—');
    min.addEventListener('click', toggleMin);
    const close = el('button', 'tr-winbtn', { title: `Close (${skLabel(bindKey('toggle'))}, or the toolbar icon, to reopen)` }, '✕');
    close.addEventListener('click', hideCard);
    title.append(move, min, close);
    enableDrag(title);
    card.appendChild(title);

    const body = el('div', 'tr-body'); card.appendChild(body);

    if (!state.authed) {
      body.appendChild(el('div', 'signin', null, 'Sign in via the TailorResume toolbar icon.'));
      return;
    }

    // update-available nudge (manual installs don't auto-update)
    if (state.update && state.update.updateAvailable) {
      const u = el('div', 'update', null,
        `⬆ Update available: v${state.update.latest}. Open tailorresume.duckdns.org → Help to update.`);
      body.appendChild(u);
    }

    // profile row — each option shows that profile's to-do count; the chip on
    // the right shows the total to-do across all profiles.
    const prow = el('div', 'tr-line');
    prow.appendChild(el('div', 'tile', null, '👤'));
    const sel = el('select', 'field');
    for (const p of state.profiles) {
      const o = el('option', null, { value: p.id }, `${p.name} · ${p.pending_count ?? 0} to apply`);
      if (p.id === state.profileId) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => selectProfile(sel.value));
    prow.appendChild(sel);
    const total = state.profiles.reduce((s, x) => s + (x.pending_count || 0), 0);
    prow.appendChild(el('div', 'count', { title: 'Total to-do across all profiles' }, `Σ ${total}`));
    body.appendChild(prow);

    // company-role row (the active job stays "pinned" through the apply flow)
    const jrow = el('div', 'tr-line');
    jrow.appendChild(el('div', 'tile', null, '💼'));
    const m = state.match;
    const jobText = (m && m.matched && m.job)
      ? `${m.job.company}  -  ${m.job.job_title}`
      : (m ? 'No matching job for this page' : 'Checking this page…');
    jrow.appendChild(el('div', 'field ellipsis', { title: jobText }, jobText));
    const redetect = el('button', 'tr-winbtn', { title: 'Detect the job for this page again' }, '↻');
    redetect.addEventListener('click', detect);
    jrow.appendChild(redetect);
    body.appendChild(jrow);

    // actions (each shows its shortcut underneath; sk='' → no shortcut line)
    const canDownload = !!(m && m.matched && m.resume);
    const canReport = !!(m && m.job && m.job.id);   // a matched job → can report, no download needed
    const actBtn = (cls, label, sk, onClick) => {
      const b = el('button', `btn ${cls}`, { title: sk ? `${label} (${skLabel(sk)})` : label });
      b.append(el('span', 'bl', null, label));
      if (sk) b.append(el('span', 'bk', null, skLabel(sk)));
      b.addEventListener('click', onClick);
      return b;
    };

    // top row: Download + Report
    const acts = el('div', 'tr-actions');
    const dl = actBtn('dl', '⬇ Download', bindKey('download'), doDownload);
    dl.disabled = !canDownload;
    const rep = actBtn('rep', '⚑ Report', bindKey('report'), doReport);
    rep.disabled = !canReport;
    acts.append(dl, rep);
    body.appendChild(acts);

    body.appendChild(el('div', 'copy-label', null, 'COPY — click copies · shortcut pastes into the focused field'));

    // copy grid
    const grid = el('div', 'grid');
    const p = selectedProfile();
    for (const f of COPY_FIELDS) {
      const value = p ? (f.get(p) || '') : '';
      const sk = skLabel(bindKey(f.id));
      const cell = el('button', 'cell', { title: `${f.lbl}${value ? '' : ' (empty)'} — click to copy, ${sk} to paste` });
      cell.append(
        el('div', 'ico', null, f.ico),
        el('div', 'lbl', null, f.lbl),
        el('div', 'sk', null, sk),
      );
      cell.disabled = !state.downloaded || !value;
      cell.addEventListener('click', async () => {
        if (await copy(value)) { cell.classList.add('copied'); setTimeout(() => cell.classList.remove('copied'), 600); toast(`Copied: ${f.lbl}`, 'ok'); }
        else toast('Copy failed', 'err');
      });
      grid.appendChild(cell);
    }
    body.appendChild(grid);

    // bottom row: Screenshot + Mark as Applied (the final apply steps).
    // Screenshot enables after Download; Mark as Applied enables after a
    // successful screenshot (same endpoint as the Apply tab's button).
    const bottom = el('div', 'tr-actions');
    const shot = actBtn('shot', '📷 Screenshot', bindKey('screenshot'), doScreenshot);
    shot.disabled = !state.downloaded;
    const applyBtn = actBtn('applied', state.applied ? '✓ Applied' : '✅ Mark Applied', '', doMarkApplied);
    applyBtn.disabled = state.applied || !state.screenshotDone || !(m && m.resume && m.resume.saved_resume_id);
    bottom.append(shot, applyBtn);
    body.appendChild(bottom);

    // keep sub-frames' paste context fresh
    if (state.authed) pushPasteCtx();
  }

  // dragging -------------------------------------------------------------
  function enableDrag(handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('tr-winbtn')) return; // don't drag from buttons
      e.preventDefault();
      const card = state.card;
      const rect = card.getBoundingClientRect();
      const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
      handle.classList.add('drag');
      const onMove = (ev) => {
        let left = ev.clientX - offX, top = ev.clientY - offY;
        left = Math.max(0, Math.min(left, window.innerWidth - rect.width));
        top = Math.max(0, Math.min(top, window.innerHeight - 40));
        card.style.left = `${left}px`; card.style.top = `${top}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('drag');
        chrome.storage.local.set({ [POS_KEY]: { left: parseInt(card.style.left), top: parseInt(card.style.top) } });
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  async function toggleMin() {
    const m = state.card.classList.toggle('min');
    await chrome.storage.local.set({ [MIN_KEY]: m });
    render();
  }
  function hideCard() { state.host.style.display = 'none'; }
  function showCard() { state.host.style.display = 'block'; }
  function toggleVisible() {
    state.host.style.display = state.host.style.display === 'none' ? 'block' : 'none';
  }

  // actions --------------------------------------------------------------
  async function selectProfile(id) {
    state.profileId = id;
    await chrome.storage.local.set({ [PROFILE_KEY]: id });
    await detect();
  }

  // Explicit detection — REPLACES the active job (initial load, profile change,
  // manual ↻, accept-switch). Resets the download/enable state.
  async function detect() {
    if (!state.authed || !state.profileId) return;
    state.lastUrl = location.href;
    state.match = null;
    state.downloaded = false; state.screenshotDone = false; state.applied = false;
    render();
    const res = await send({ type: 'findResume', profileId: state.profileId, url: location.href });
    state.match = res?.ok ? res : { matched: false, job: null, resume: null };
    state.applied = matchApplied(state.match);
    render();
    savePinned();   // pin the job for this tab (or clear if no match)
  }

  // Non-destructive re-detect on URL change. Multi-step apply flows (view→apply,
  // wizard steps, ATS redirects) change the URL; we must NOT wipe the pinned job
  // After restoring a pinned job, confirm it still matches the CURRENT page.
  // This guards the "navigated to a DIFFERENT job in the same tab" case: if the
  // new URL matches another job, switch to it (resetting the apply state) so we
  // never offer the wrong resume. If the URL matches the same job or no job (a
  // post-submit confirmation page), keep the pinned state untouched.
  async function verifyPin() {
    if (!state.authed || !state.profileId) return;
    state.lastUrl = location.href;
    const res = await send({ type: 'findResume', profileId: state.profileId, url: location.href });
    const found = res?.ok ? res : { matched: false, job: null, resume: null };
    const foundId = found.matched ? found.job?.id : null;
    const pinnedId = state.match?.job?.id;
    if (foundId && foundId !== pinnedId) {     // different job on this page → switch
      state.match = found;
      state.downloaded = false; state.screenshotDone = false;
      state.applied = matchApplied(found);
      savePinned();
      render();
    }
  }

  async function doDownload() {
    const m = state.match;
    if (!m?.resume) return;
    const base = sanitizeFilename(selectedProfile()?.name || '');
    const filename = base ? `${base} Resume.pdf` : 'Resume.pdf';
    const res = await send({ type: 'downloadResume', resumeId: m.resume.saved_resume_id, filename });
    if (res?.ok) { state.downloaded = true; savePinned(); toast('Resume downloaded', 'ok'); render(); }
    else toast(res?.error || 'Download failed', 'err');
  }
  async function doReport() {
    const m = state.match;
    if (!m?.job?.id) return;                                 // report needs only a matched job
    const reason = window.prompt(`Report "${m.job.company} · ${m.job.job_title}".\nWhat's wrong? (link broken / closed / spam)`);
    if (reason == null) return;
    const r = (reason || '').trim();
    if (!r) { toast('A reason is required', 'err'); return; }
    const res = await send({ type: 'reportJob', jobId: m.job.id, reason: r });
    if (res?.ok) { toast('Job reported', 'ok'); await detect(); }
    else toast(res?.error || 'Report failed', 'err');
  }
  async function doScreenshot() {
    if (!state.downloaded) return;
    const prev = state.host.style.display;
    state.host.style.display = 'none';   // (a "Capturing…" toast here would be inside the hidden card)
    // let the hidden bar clear from the frame before we capture
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      // One worker call does the whole capture: full page via DevTools, or — if
      // the debugger isn't available — a single visible-viewport frame. Either
      // way it's ONE clean image (no tiling).
      const res = await send({
        type: 'captureFullAndUpload',
        profileId: state.profileId, jobId: state.match?.job?.id || '', url: location.href,
      });
      state.host.style.display = prev;
      if (res?.ok) {
        state.screenshotDone = true;            // unlocks "Mark as Applied"
        savePinned();
        if (res.mode === 'full') {
          toast('Full-page screenshot saved', 'ok');
        } else {
          toast('Saved the visible area only — allow the extension’s "debugger" permission for full-page capture', 'err');
        }
        render();
      } else {
        toast(res?.error || 'Screenshot failed', 'err');
      }
    } catch (e) {
      state.host.style.display = prev;
      toast(e?.message || 'Screenshot failed', 'err');
    }
  }

  // Mark as applied — same endpoint as the Apply tab's button. Gated behind a
  // successful screenshot. Refreshes the to-do counts afterward.
  async function doMarkApplied() {
    const m = state.match;
    const rid = m && m.resume && m.resume.saved_resume_id;
    if (!rid) { toast('No matched resume to mark', 'err'); return; }
    if (state.applied) return;
    if (!state.screenshotDone) { toast('Take a screenshot first', 'err'); return; }
    const res = await send({ type: 'markApplied', resumeId: rid });
    if (res?.ok) {
      state.applied = true;
      if (m.resume) m.resume.applied_status = 'applied';
      savePinned();
      toast('Marked as applied', 'ok');
      reloadProfiles();                          // update to-do counts
      render();
    } else {
      toast(res?.error || 'Failed to mark applied', 'err');
    }
  }

  // Re-fetch profiles so the to-do counts reflect a just-applied job.
  async function reloadProfiles() {
    const meta = await send({ type: 'profilesMeta' });
    if (meta?.ok) { state.profiles = meta.profiles || []; render(); }
  }

  // Persist the matched job + apply state for THIS tab in the worker, so a hard
  // navigation (e.g. the redirect after submitting an application) restores it
  // instead of re-detecting against the new URL and disabling every button.
  function savePinned() {
    if (!(state.match && state.match.matched)) { send({ type: 'clearPinned' }); return; }
    send({
      type: 'setPinned',
      pinned: {
        profileId: state.profileId,
        match: state.match,
        downloaded: state.downloaded,
        screenshotDone: state.screenshotDone,
        applied: state.applied,
      },
    });
  }

  // keyboard shortcuts (Alt + a user-configurable key). All handled in-page so
  // they're remappable in Help → Shortcuts. Actions trigger; copy fields PASTE
  // into the focused input (clicking the card buttons still copies instead).
  // If the bar is hidden, show it so an action's prompt/feedback has context.
  function ensureVisibleForAction() {
    if (state.host && state.host.style.display === 'none') state.host.style.display = 'block';
  }
  // Run an action in this (top) frame. Shared by the keydown handler and by
  // actions forwarded from a sub-frame.
  function runAction(action) {
    if (action === 'toggle') { toggleVisible(); return; }
    if (!state.authed) return;
    const m = state.match;
    if (action === 'download') {
      if (m && m.matched && m.resume) { ensureVisibleForAction(); doDownload(); }
      else toast('No matching resume to download', 'err');
      return;
    }
    if (action === 'report') {
      if (m && m.job && m.job.id) { ensureVisibleForAction(); doReport(); }
      else toast('No matching job to report', 'err');
      return;
    }
    if (action === 'screenshot') {
      if (state.downloaded) doScreenshot(); else toast('Download the resume first', 'err');
      return;
    }
  }

  document.addEventListener('keydown', async (e) => {
    if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const k = codeToKey(e.code);            // physical key — layout/modifier-proof (macOS Option)
    if (!k) return;
    const action = actionForKey(k);
    if (!action) return;
    e.preventDefault(); e.stopPropagation();

    if (!COPY_IDS.has(action)) { runAction(action); return; }   // toggle/download/report/screenshot
    if (!state.authed) return;
    // copy field → paste into the focused page field
    const f = COPY_FIELDS.find((x) => x.id === action);
    if (!f) return;
    if (!state.downloaded) { toast('Download the resume first', 'err'); return; }
    const p = selectedProfile(); if (!p) return;
    const value = f.get(p) || '';
    if (!value) { toast(`${f.lbl} is empty`, 'err'); return; }
    if (pasteIntoField(value)) toast(`Pasted: ${f.lbl}`, 'ok');
    else { await copy(value); toast(`${f.lbl} copied (focus a field to paste)`, 'ok'); }
  }, true);

  // Push the per-tab paste context to the worker so sub-frames (ATS iframes)
  // can resolve copy values + the download gate. Called from render().
  function pushPasteCtx() {
    const p = selectedProfile();
    const values = {};
    if (p) for (const f of COPY_FIELDS) values[f.id] = f.get(p) || '';
    send({ type: 'setPasteCtx', context: { downloaded: !!state.downloaded, values } });
  }

  // Refresh the user's custom shortcut bindings from the server, and cache them
  // so a later fetch failure doesn't revert to defaults.
  async function loadShortcuts() {
    if (!state.authed) return;
    const r = await send({ type: 'shortcuts' });
    if (r?.ok && r.bindings) {
      state.bindings = { ...DEFAULT_BINDINGS, ...r.bindings };
      chrome.storage.local.set({ [BINDINGS_KEY]: r.bindings });
      render();
    }
  }

  // 'command' (popup show/toggle) + 'frameAction' (sub-frame) messages.
  let pendingToggle = false, pendingShow = false;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'frameAction') { if (state.card) runAction(msg.action); return; }
    if (msg?.type !== 'command') return;
    if (!state.card) {
      // Command arrived before mount() finished (e.g. popup injected us just
      // now). Remember it so the card resolves correctly once mounted.
      if (msg.command === 'show-bar') pendingShow = true;
      else if (msg.command === 'toggle-bar') pendingToggle = true;
      return;
    }
    if (msg.command === 'show-bar') showCard();
    else if (msg.command === 'toggle-bar') toggleVisible();
  });

  // init + SPA url watch -------------------------------------------------
  async function init() {
    // Seed bindings from cache first so the card shows custom keys instantly
    // and a failed shortcuts fetch never reverts to defaults.
    try {
      const c = await chrome.storage.local.get(BINDINGS_KEY);
      if (c && c[BINDINGS_KEY]) state.bindings = { ...DEFAULT_BINDINGS, ...c[BINDINGS_KEY] };
    } catch { /* */ }
    const s = await send({ type: 'getSession' });
    state.authed = !!s?.authed;
    let restored = false;
    if (state.authed) {
      const meta = await send({ type: 'profilesMeta' });
      if (meta?.ok) {
        state.profiles = meta.profiles || [];
        const { [PROFILE_KEY]: saved } = await chrome.storage.local.get(PROFILE_KEY);
        state.profileId = (state.profiles.find((p) => p.id === saved) ? saved : state.profiles[0]?.id) || '';
      }
      // Restore this tab's pinned job (set on first detect). This is what keeps
      // the job + download/screenshot/applied state across the hard navigation a
      // site does after you submit — instead of re-detecting the new URL.
      const pin = await send({ type: 'getPinned' });
      const p = pin && pin.ok && pin.pinned;
      if (p && p.profileId === state.profileId && p.match && p.match.matched) {
        state.match = p.match;
        state.downloaded = !!p.downloaded;
        state.screenshotDone = !!p.screenshotDone;
        state.applied = !!p.applied;
        restored = true;
      }
    }
    render();
    // Detect the job ONCE per tab. After that the pin carries it across URL
    // changes; use the ↻ button (or switch profile) to re-detect deliberately.
    if (state.authed && state.profileId && !restored) detect();
    else if (restored) verifyPin();   // switch only if THIS page is a different job
    if (state.authed) loadShortcuts();
    // background update check (manual installs don't auto-update)
    send({ type: 'checkUpdate' }).then((u) => { if (u?.ok) { state.update = u; render(); } });
  }
  // SPA sites (Greenhouse, Workday…) can replace the DOM on a soft route change
  // and drop our host node. Re-append it if it got detached (the mount guard
  // would otherwise block a re-inject, leaving no card).
  function ensureMounted() {
    if (state.host && !state.host.isConnected) {
      (document.documentElement || document.body).appendChild(state.host);
    }
  }
  // Once a job is matched it stays pinned across URL changes (apply steps,
  // post-submit redirects) — we never wipe it. The only auto-detect is a
  // recovery path: while NOTHING is matched yet (e.g. the first detect hit a
  // transient/loading URL), re-detect on a soft (SPA) URL change so the bidder
  // isn't stranded on the real job page with no resume. The interval also keeps
  // the card attached on SPA sites that wipe DOM nodes.
  setInterval(() => {
    ensureMounted();
    if (state.authed && !(state.match && state.match.matched) && location.href !== state.lastUrl) detect();
  }, 1500);
  window.addEventListener('focus', () => {
    ensureMounted();
    if (state.authed) loadShortcuts();   // pick up changes made in Help → Shortcuts
  });

  // Live refresh: when you sign in/out via the popup, the token in
  // chrome.storage changes — re-init so this already-open tab's card updates
  // immediately without a manual page reload. Also un-hides the card on login.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.token || !state.host) return;
    const justLoggedIn = !!changes.token.newValue;
    if (justLoggedIn) state.host.style.display = 'block';
    init();
  });

  mount().then(init);
})();
