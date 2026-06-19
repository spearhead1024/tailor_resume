// Service worker: owns auth/session, brokers all API calls (so content scripts
// never fetch cross-origin or hold the token), captures screenshots, and routes
// keyboard commands to the active tab's bar.

import { api, getConfig, setSession, clearSession, setApiBase, ApiError } from './lib/api.js';

// Per-tab "paste context" the top frame pushes (selected profile's field values
// + download gate) so sub-frames (cross-origin ATS iframes) can resolve a paste
// shortcut. Cleared when the tab closes.
const pasteCtxByTab = new Map();

// Per-tab PINNED job/apply state. The card detects the job ONCE per tab; this
// keeps the matched job + download/screenshot/applied state across URL changes
// — including the hard navigation a site does after you submit an application,
// which would otherwise destroy the content script and disable every button.
// Backed by chrome.storage.session so it survives a service-worker eviction
// mid-navigation (in-memory alone would be lost exactly then).
const pinnedByTab = new Map();
const PIN_KEY = (id) => `pin_${id}`;

function _dropTab(tabId) {
  pasteCtxByTab.delete(tabId);
  pinnedByTab.delete(tabId);
  try { chrome.storage.session.remove(PIN_KEY(tabId)); } catch { /* */ }
}
chrome.tabs.onRemoved.addListener(_dropTab);
// onReplaced fires when Chrome swaps a tab's id (prerender/BFCache) — clean the old id.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => _dropTab(removedTabId));

// On install/update, inject the content script into every already-open http(s)
// tab — Chrome only auto-injects into tabs loaded AFTER install, so without
// this the card wouldn't appear on tabs you already had open.
chrome.runtime.onInstalled.addListener(async () => {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }); } catch { return; }
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content/content.js'] });
    } catch { /* restricted page (e.g. chrome://, web store) — skip */ }
  }
});

// ---- message router (content script + popup -> worker) ---------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((e) => {
    sendResponse({ ok: false, error: e?.message || 'Error', status: e?.status });
  });
  return true; // async
});

async function handle(msg, sender) {
  switch (msg?.type) {
    case 'getSession': {
      const { token, user, apiBase } = await getConfig();
      return { ok: true, authed: !!token, user, apiBase };
    }
    case 'login': {
      const res = await api.login(msg.identifier, msg.password);
      await setSession({ token: res.token, user: res.user });
      return { ok: true, user: res.user };
    }
    case 'logout': {
      await clearSession();
      // Drop all per-tab state so a pinned job/resume can't leak to the next user.
      pinnedByTab.clear();
      pasteCtxByTab.clear();
      try { await chrome.storage.session.clear(); } catch { /* */ }
      return { ok: true };
    }
    case 'setApiBase': {
      await setApiBase(msg.apiBase);
      return { ok: true };
    }
    case 'profilesMeta': {
      const data = await api.profilesMeta();
      return { ok: true, role: data.role, profiles: data.profiles || [] };
    }
    case 'profileFull': {
      return { ok: true, profile: await api.profileFull(msg.profileId) };
    }
    case 'findResume': {
      return { ok: true, ...(await api.findResumeByUrl(msg.profileId, msg.url)) };
    }
    case 'downloadResume': {
      return await downloadResume(msg.resumeId, msg.filename);
    }
    case 'markApplied': {
      await api.markApplied(msg.resumeId);
      return { ok: true };
    }
    case 'reportJob': {
      await api.reportJob(msg.jobId, msg.reason);
      return { ok: true };
    }
    case 'openTabs': {
      return await openTabs(msg.urls, sender);
    }
    case 'getCss': {
      // Fetch our own bundled CSS in the worker (always allowed) so the content
      // script can inline it — page CSP can't block the card's styles this way.
      try {
        const css = await (await fetch(chrome.runtime.getURL('content/bar.css'))).text();
        return { ok: true, css };
      } catch { return { ok: false, css: '' }; }
    }
    case 'getPinned': {
      const id = sender?.tab?.id;
      if (id == null) return { ok: true, pinned: null };
      let pinned = pinnedByTab.get(id);
      if (!pinned) {
        try { const s = await chrome.storage.session.get(PIN_KEY(id)); pinned = s[PIN_KEY(id)] || null; } catch { /* */ }
        if (pinned) pinnedByTab.set(id, pinned);
      }
      // Only hand back a pin that belongs to the currently signed-in user.
      const { user } = await getConfig();
      if (pinned && pinned.userId && user?.id && pinned.userId !== user.id) pinned = null;
      return { ok: true, pinned: pinned || null };
    }
    case 'setPinned': {
      const id = sender?.tab?.id;
      if (id == null) return { ok: false };
      const { user } = await getConfig();
      const pinned = { ...(msg.pinned || {}), userId: user?.id || '' };
      pinnedByTab.set(id, pinned);
      try { await chrome.storage.session.set({ [PIN_KEY(id)]: pinned }); } catch { /* */ }
      return { ok: true };
    }
    case 'clearPinned': {
      const id = sender?.tab?.id;
      if (id == null) return { ok: false };
      pinnedByTab.delete(id);
      try { await chrome.storage.session.remove(PIN_KEY(id)); } catch { /* */ }
      return { ok: true };
    }
    case 'captureFullAndUpload': {
      return await captureFullAndUpload(msg, sender);
    }
    case 'setPasteCtx': {
      if (sender?.tab?.id != null) pasteCtxByTab.set(sender.tab.id, msg.context || {});
      return { ok: true };
    }
    case 'getPasteValue': {
      const ctx = sender?.tab?.id != null ? pasteCtxByTab.get(sender.tab.id) : null;
      if (!ctx) return { ok: false };
      return { ok: true, downloaded: !!ctx.downloaded, value: (ctx.values || {})[msg.actionId] || '' };
    }
    case 'frameAction': {
      // A sub-frame (ATS iframe) hit an action shortcut — run it in the top frame.
      if (sender?.tab?.id != null) {
        try { await chrome.tabs.sendMessage(sender.tab.id, { type: 'frameAction', action: msg.action }, { frameId: 0 }); }
        catch { /* top frame not ready */ }
      }
      return { ok: true };
    }
    case 'extensionVersion': {
      return { ok: true, ...(await api.extensionVersion()) };
    }
    case 'shortcuts': {
      try { return { ok: true, ...(await api.shortcuts()) }; }
      catch { return { ok: false }; }
    }
    case 'toggleBarActiveTab': {
      return await toggleBarActiveTab();
    }
    case 'checkUpdate': {
      const current = chrome.runtime.getManifest().version;
      try {
        const v = await api.extensionVersion();
        return { ok: true, current, latest: v.version, changelog: v.changelog,
                 updateAvailable: cmpVersions(v.version, current) > 0 };
      } catch {
        return { ok: true, current, updateAvailable: false };
      }
    }
    default:
      return { ok: false, error: `Unknown message: ${msg?.type}` };
  }
}

// semver-ish compare: returns >0 if a newer than b
function cmpVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ---- resume download -------------------------------------------------------
// Manual download: always pops the browser's "Save As" dialog (saveAs: true) so
// the bidder chooses where to save and confirms each time — never a silent
// auto-download to the Downloads folder.
async function downloadResume(resumeId, filename) {
  const resp = await api.resumePdf(resumeId);
  const blob = await resp.blob();
  const url = await blobToDataUrl(blob);
  await chrome.downloads.download({
    url,
    filename: filename || 'Resume.pdf',
    saveAs: true,
  });
  return { ok: true };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// ---- open many job tabs at once --------------------------------------------
// The web app can't open N tabs from one click (the pop-up blocker caps it at
// one), but the extension holds the "tabs" permission, so we open them here —
// in the background, like Ctrl+click. No per-site prompt, no blocker.
async function openTabs(urls, sender) {
  if (!Array.isArray(urls) || urls.length === 0) return { ok: false, error: 'No URLs.' };
  const windowId = sender?.tab?.windowId;
  let opened = 0;
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url || '')) continue;
    try { await chrome.tabs.create({ url, active: false, windowId }); opened++; } catch { /* skip */ }
  }
  return { ok: true, opened };
}

// ---- full-page screenshot via the DevTools protocol ------------------------
// captureBeyondViewport grabs the WHOLE document in ONE pass — no scrolling, no
// stitching, so it can never produce the "repeated N times" tiling the old
// scroll-and-stitch did. Returns a data URL, or throws so captureFullAndUpload
// falls back to a single visible-viewport capture.
function dbgAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      const e = chrome.runtime.lastError;
      e ? reject(new Error(e.message)) : resolve();
    });
  });
}
function dbgDetach(target) {
  return new Promise((resolve) => {
    try { chrome.debugger.detach(target, () => { void chrome.runtime.lastError; resolve(); }); }
    catch { resolve(); }
  });
}
function dbgSend(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (r) => {
      const e = chrome.runtime.lastError;
      e ? reject(new Error(e.message)) : resolve(r);
    });
  });
}
async function cdpFullScreenshot(tabId) {
  const target = { tabId };
  await dbgAttach(target);
  try {
    await dbgSend(target, 'Page.enable');
    const m = await dbgSend(target, 'Page.getLayoutMetrics');
    const size = m.cssContentSize || m.contentSize || {};
    const width = Math.ceil(size.width || 0);
    const height = Math.ceil(size.height || 0);
    if (!width || !height) throw new Error('No layout metrics');
    // Chrome can't make an image larger than ~16384px on a side. Instead of
    // CROPPING a tall page (losing the bottom), SCALE the whole page down to fit
    // — the entire document is still captured, just at lower resolution.
    const MAX = 16384;
    const scale = Math.min(1, MAX / height, MAX / width);
    const shot = await dbgSend(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,   // render the whole document in one pass (no tiling)
      fromSurface: true,
      clip: { x: 0, y: 0, width, height, scale },
    });
    if (!shot || !shot.data) throw new Error('Empty capture');
    return 'data:image/png;base64,' + shot.data;
  } finally {
    await dbgDetach(target);
  }
}
async function captureFullAndUpload({ profileId, url, jobId }, sender) {
  const tabId = sender?.tab?.id;
  const windowId = sender?.tab?.windowId;
  if (tabId == null) return { ok: false, error: 'No tab.' };
  let dataUrl;
  let mode;
  try {
    dataUrl = await cdpFullScreenshot(tabId);   // true full document, one image
    mode = 'full';
  } catch (e) {
    // debugger unavailable (permission not granted/enabled, DevTools open, …).
    // Capture ONLY the visible viewport — a single clean frame, never a tiled
    // multi-slice stitch (which is what produced "repeated N times").
    console.warn('[TailorResume] full-page (DevTools) capture unavailable, using viewport:', e?.message);
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      mode = 'viewport';
    } catch (e2) {
      return { ok: false, error: 'Capture failed (the page may block screenshots).' };
    }
  }
  const blob = await (await fetch(dataUrl)).blob();
  const form = new FormData();
  form.append('image', blob, 'screenshot.png');
  form.append('profile_id', profileId || '');
  form.append('url', url || sender?.tab?.url || '');
  form.append('job_id', jobId || '');
  const res = await api.uploadScreenshot(form);
  return { ok: true, id: res.id, mode };
}

// ---- show/hide the bar on the active tab -----------------------------------
// Popup "Show/hide" button. If the bar is already on the page, TOGGLE it. If it
// isn't injected yet (tab predates install, or page just loaded), inject it and
// SHOW it — never toggle a freshly-injected bar off (that was the old bug where
// the bar "didn't appear").
async function toggleBarActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return { ok: false, error: 'No active tab.' };
  const url = tab.url || '';
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "The bar can't run on this page (e.g. chrome:// or the Web Store)." };
  }
  // Already injected → toggle it (top frame only).
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'command', command: 'toggle-bar' }, { frameId: 0 });
    return { ok: true };
  } catch {
    // Not injected yet — inject, then explicitly SHOW (don't toggle).
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
  } catch (e) {
    return { ok: false, error: "Couldn't load the bar on this page." };
  }
  await new Promise((r) => setTimeout(r, 200));
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'command', command: 'show-bar' }, { frameId: 0 });
  } catch {
    // Fresh injection already shows the bar; nothing more to do.
  }
  return { ok: true };
}

// All keyboard shortcuts are handled in-page by the content script (so users
// can remap them in Help → Shortcuts). No chrome.commands here.
