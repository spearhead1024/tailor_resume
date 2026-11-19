/* ChatGPT connection — the extension's WORKER (imported by background.js).
 *
 * The queue lives on the SERVER (/api/gpt, table cv_queue): which jobs get a CV written ahead
 * (the job on screen + the next one), which questions to answer, which ChatGPT conversations to
 * delete. Nothing finished is lost when the browser closes — the server builds the CV the moment
 * ChatGPT's JSON arrives, and a lease that runs out (a closed browser) puts unfinished work back
 * in the queue. This worker only:
 *   claim     leases work for its free ChatGPT tabs (PARALLEL)
 *   run       one REAL chatgpt.com tab per task — opened in the background (it doesn't take the
 *             bidder's focus) but visible in the tab strip, where the bidder can watch it; it is
 *             closed when its work is done. gpt/driver.js does the work inside and reports back.
 *             (Up to 1.4 ChatGPT ran in hidden frames of an offscreen document, which needed
 *             chatgpt.com's anti-framing headers stripped — real tabs need no such trick.)
 *   report    started (a conversation ChatGPT just opened) / result (→ the server builds the CV) /
 *             answers / fail / release / deleted
 *   mirror    the bidder's queue rows into chrome.storage (gptThreads), so the panel redraws
 *
 * ChatGPT conversations are deleted, not just left: the server records every conversation the
 * moment it opens and hands this worker batches of chats to delete (the job applied / skipped,
 * a failed or re-written CV, a closed browser, Disconnect, 2 hours idle). Deleting goes on while
 * disconnected too — then that is the only thing it does.
 *
 * Paid ChatGPT only. Connecting (and Continue) first checks the account in a ChatGPT tab
 * (status 'checking'); the Free plan — or a plan that can't be confirmed — stops all work
 * (status 'needs_plan'). The driver checks again before every CV / answers.
 * status: off | checking | ok | needs_login | needs_plan | limited
 *
 * Local state (chrome.storage.local): gptState (connection; toDelete = chats waiting to be
 * deleted), gptFrames (this browser's ChatGPT tabs — "frames" — their leased tasks and the
 * conversation each one opened), gptDevice (this browser's id), gptThreads (the mirror), gptLegacyChats (chats an
 * older version left, until the server has them). */

import { request } from '../lib/api.js';
import { GPT_KEYS as K, CHAT_ORIGINS, CHAT_URL, PARALLEL, gptModels } from './client.js';
import { answersPrompt, cleanAnswer } from './prompts.js';

const TIMEOUT_MIN = 6;                  // ChatGPT's answer to the CV prompt
// How long a frame may work before it is given up (within the server's lease).
const WORK_LIMIT_MS = { write: (TIMEOUT_MIN + 4) * 60_000, answer: 5 * 60_000, delete: 3 * 60_000 };
const SILENT_LIMIT_MS = 2 * 60_000;     // a frame whose driver stopped reporting (crashed / never started)
const CHECK_LIMIT_MS = 90_000;          // the account check
const DRIVER_ID = 'tr-gpt-driver';
const FRAMES = 'gptFrames';
const OUR_TABS = 'gptTabs';             // session storage: the ids of the ChatGPT tabs this extension opened
const KEPT = 'gptKept';                 // session storage: { "<profile>:<job>": { tabId, conversation } } — see keepTab
const FOCUS = 'gptFocus';               // session storage: { key, windowId } — the job selected in the panel (see place)
const HIDDEN_WIN = 'gptHiddenWin';      // session storage: the id of the minimized window the other ChatGPT tabs live in
const MAX_TABS = PARALLEL + 1;          // our ChatGPT tabs in all: the selected job's, the next job's, one more chat

const now = () => Date.now();
// The last 60 things the worker did with tabs (session storage 'gptLog') — for diagnosing a bidder's report.
let logLock = Promise.resolve();
function dlog(...parts) {
  const line = `${new Date().toISOString().slice(11, 23)} ${parts.join(' ')}`;
  logLock = logLock.then(async () => {
    const got = (await chrome.storage.session.get('gptLog').catch(() => ({}))).gptLog || [];
    await chrome.storage.session.set({ gptLog: [...got.slice(-59), line] }).catch(() => {});
  }).catch(() => {});
}
const read = async (key, fallback) => (await chrome.storage.local.get(key))[key] ?? fallback;
const state = async () => ({ enabled: false, status: 'off', notice: '', cooldownUntil: 0, plan: '', checkFrame: '', checkStartedAt: 0, toDelete: 0, ...(await read(K.state, {})) });
const setState = async (patch) => chrome.storage.local.set({ [K.state]: { ...(await state()), ...patch } });
const hasChatAccess = () => chrome.permissions.contains({ origins: CHAT_ORIGINS }).catch(() => false);
const api = (path, body) => request(path, body === undefined ? undefined : { method: 'POST', body });
const PLAN_NOTICE = {
  free_plan: 'This ChatGPT account is on the Free plan. Sign in to chatgpt.com with a paid account (Plus, Pro, Team or Enterprise), then press Continue.',
  plan_unknown: 'Could not confirm that this ChatGPT account has a paid plan. Open chatgpt.com, make sure a paid account is signed in, then press Continue.',
  needs_login: 'ChatGPT is not signed in. Sign in to chatgpt.com in this browser with a paid account, then press Continue.',
};

async function deviceId() {
  let id = await read('gptDevice', '');
  if (!id) { id = `dev-${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; await chrome.storage.local.set({ gptDevice: id }); }
  return id;
}

// ---------- this browser's frames (one at a time through the lock) ----------
let lock = Promise.resolve();
function frames(fn) {
  const run = lock.then(async () => {
    const all = await read(FRAMES, {});
    const out = await fn(all);
    await chrome.storage.local.set({ [FRAMES]: all });
    return out;
  });
  lock = run.catch(() => {});
  return run;
}
export const gptBusy = async () => Object.keys(await read(FRAMES, {})).length > 0;   // a restart now would lose work

// ---------- ChatGPT tabs ----------
// A work unit is still called a "frame" (its id: trgpt-<tab id>); it is a real, visible tab. Our tab
// ids are kept in SESSION storage: after a browser restart the old ids are gone, so a new tab that
// happens to get an old id is never mistaken for ours (its work was handed back meanwhile).
const frameOfTab = (tabId) => `trgpt-${tabId}`;
const tabOfFrame = (id) => Number(String(id || '').replace(/^trgpt-/, ''));
const ourTabs = async () => new Set((await chrome.storage.session.get(OUR_TABS).catch(() => ({})))[OUR_TABS] || []);
const setOurTabs = (set) => chrome.storage.session.set({ [OUR_TABS]: [...set] }).catch(() => {});
let tabsLock = Promise.resolve();
const withTabs = (fn) => { const run = tabsLock.then(async () => { const set = await ourTabs(); const out = await fn(set); await setOurTabs(set); return out; }); tabsLock = run.catch(() => {}); return run; };

// The driver is a content script for chatgpt.com — registered only once access was granted. It
// does nothing in the bidder's own ChatGPT tabs (the worker doesn't know them).
export async function ensureDriver() {
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [DRIVER_ID] }).catch(() => []);
  if (have.length) return;
  await chrome.scripting.registerContentScripts([{
    id: DRIVER_ID, matches: CHAT_ORIGINS, js: ['gpt/driver.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true,
  }]);
}
// ---------- placing tabs: the bidder sees ONE ChatGPT tab — the selected job's chat ----------
// The panel tells the worker which job is on screen (action 'focus'). That job's tab sits in the
// bidder's window, next to their tab; every other ChatGPT tab of ours — the next job's CV being
// written ahead, a chat kept for later, the account check — lives in a minimized window of its own.
// When the bidder moves to another job, the tabs swap places (chrome.tabs.move keeps the page, and
// whatever ChatGPT is writing in it, alive). A tab is never reused for another job while it is the
// job on screen, so the chat the bidder looks at is always that job's.
const focusNow = async () => (await chrome.storage.session.get(FOCUS).catch(() => ({})))[FOCUS] || { key: '', windowId: null };
async function hiddenWindowId() {
  const id = (await chrome.storage.session.get(HIDDEN_WIN).catch(() => ({})))[HIDDEN_WIN];
  return id != null && await chrome.windows.get(id).catch(() => null) ? id : null;
}
// The minimized window, opened with this first tab when there is none (one at a time: never two). → the tab
let hiddenLock = Promise.resolve();
function inHiddenWindow(make) {
  const run = hiddenLock.then(async () => {
    const win = await hiddenWindowId();
    if (win != null) return make(win);
    const w = await make(null);
    if (w?.windowId != null) await chrome.storage.session.set({ [HIDDEN_WIN]: w.windowId }).catch(() => {});
    return w;
  });
  hiddenLock = run.catch(() => {});
  return run;
}
const tabInHiddenWindow = (url) => inHiddenWindow(async (win) => (win != null
  ? chrome.tabs.create({ windowId: win, url, active: false })
  : (await chrome.windows.create({ url, state: 'minimized', focused: false, type: 'normal' })).tabs[0]));
// The bidder's window: the panel's, else the last one they used (never the minimized one).
async function viewWindowId() {
  const hidden = await hiddenWindowId();
  const { windowId } = await focusNow();
  if (windowId != null && windowId !== hidden && await chrome.windows.get(windowId).catch(() => null)) return windowId;
  const wins = (await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => [])).filter((w) => w.id !== hidden);
  return (wins.find((w) => w.focused) || wins[0])?.id ?? null;
}
async function moveTab(tabId, windowId) {
  if (windowId == null) return;
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t || t.windowId === windowId) return;
  if (t.active && t.windowId !== (await hiddenWindowId())) return;   // the bidder is reading it right now: left where it is
  let index = -1;
  if (windowId !== (await hiddenWindowId())) {                          // into view: right next to the bidder's tab
    const [cur] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (cur) index = cur.index + 1;
  }
  await chrome.tabs.move(tabId, { windowId, index }).catch(() => {});
  if (windowId === (await hiddenWindowId())) await chrome.windows.update(windowId, { state: 'minimized' }).catch(() => {});
}
// Every tab of ours where it belongs: the selected job's in view, the rest in the minimized window.
let placing = Promise.resolve();
function place() {
  const run = placing.then(async () => {
    const { key: focus } = await focusNow();
    const owned = [];                                                    // [tabId, job key]
    for (const [id, f] of Object.entries(await read(FRAMES, {}))) owned.push([tabOfFrame(id), f.lease?.key || '']);
    const check = (await state()).checkFrame; if (check) owned.push([tabOfFrame(check), '']);
    for (const [k, v] of Object.entries(await keptTabs())) owned.push([v.tabId, k === IDLE ? '' : k]);
    const view = await viewWindowId();
    // Out of view first, then into view — so two ChatGPT tabs are never in sight at once.
    owned.sort((a, b) => (a[1] === focus && focus ? 1 : 0) - (b[1] === focus && focus ? 1 : 0));
    for (const [tabId, key] of owned) {
      if (focus && key === focus) await moveTab(tabId, view);
      else {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        if (!t) continue;
        await inHiddenWindow(async (win) => {
          if (win == null) {                                             // the first hidden tab opens the window
            const w = await chrome.windows.create({ tabId, state: 'minimized', focused: false }).catch(() => null);
            return w ? { windowId: w.id } : null;
          }
          if (t.windowId !== win) await moveTab(tabId, win);
          return null;
        });
      }
    }
  });
  placing = run.catch(() => {});
  return run;
}
// A tab to reuse for new work: the idle one, or the job's own old tab. Another job's chat is never
// taken over (it would have to load again when the bidder gets to that job); a new tab opens instead,
// and makeRoom closes the oldest chat once there are MAX_TABS.
async function takeIdleTab(url, key) {
  const kept = Object.entries(await keptTabs()).filter(([k]) => k === IDLE || (key && k === key));
  for (const [k, v] of kept) {
    const t = await chrome.tabs.get(v.tabId).catch(() => null);
    if (!t || (t.active && t.windowId !== await hiddenWindowId())) continue;   // never the tab the bidder is reading
    await withKept(async (all) => { delete all[k]; });
    await withTabs(async (set) => { set.add(t.id); });
    await chrome.tabs.update(t.id, { url }).catch(() => {});
    return t.id;
  }
  return null;
}
// key: the job the tab works for ('' = no job: the account check). It opens where it belongs: the job
// on screen in the bidder's window, anything else in the minimized window.
async function openFrame(url, key = '') {
  await ensureDriver();
  const reused = await takeIdleTab(url, key);
  dlog('open', key || '-', reused != null ? `reuse ${reused}` : 'new', url.slice(-20));
  await makeRoom();
  if (reused != null) return frameOfTab(reused);
  const { key: focus } = await focusNow();
  let tab;
  if (key && key === focus) {
    const view = await viewWindowId();
    const [cur] = view != null ? await chrome.tabs.query({ active: true, windowId: view }).catch(() => []) : [];
    tab = await chrome.tabs.create({ url, active: false, ...(cur ? { windowId: view, index: cur.index + 1 } : {}) });
  } else {
    tab = await tabInHiddenWindow(url);
  }
  await withTabs(async (set) => { set.add(tab.id); });
  // Chrome may discard background tabs to save memory — that would kill a CV half-written.
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  return frameOfTab(tab.id);
}
async function closeFrame(id) {
  if (!id) return;
  const tabId = tabOfFrame(id);
  await withTabs(async (set) => { set.delete(tabId); });
  await chrome.tabs.remove(tabId).catch(() => {});        // already closed by the bidder: fine
}
// The conversation a tab is on right now (https://chatgpt.com/c/<id>), read from the tab itself — so a
// tab closed the instant ChatGPT opened a chat (before the driver's next report) still has it deleted.
async function tabConversation(id) {
  const tab = await chrome.tabs.get(tabOfFrame(id)).catch(() => null);
  return /\/c\/[A-Za-z0-9][A-Za-z0-9_-]{7,}/.test(tab?.url || '') ? tab.url : '';
}
// …but only when it is the task's own chat (see alive): never the chat the tab showed before.
async function taskConversation(id, f) {
  const url = await tabConversation(id);
  const want = f?.task?.expect?.chat || '';
  if (!url) return '';
  if (want) return convId(url) === want ? url : '';
  return f?.sent ? url : '';
}
// ---------- kept tabs: a CV's chat stays open for the bidder ----------
// When a CV (or answers) is done, its tab is NOT closed: the bidder can ask ChatGPT more (tech
// questions…) in that very chat. It is closed — and the chat deleted by the server — once the job is
// done for that profile (Mark as Applied / Report / Skip), left idle 2 hours, or ChatGPT is
// disconnected: syncMirror closes every kept tab whose conversation the server no longer holds.
const convId = (url) => (String(url || '').match(/\/c\/([A-Za-z0-9][A-Za-z0-9_-]{7,})/) || [])[1] || '';
const keptTabs = async () => (await chrome.storage.session.get(KEPT).catch(() => ({})))[KEPT] || {};
let keptLock = Promise.resolve();
const withKept = (fn) => { const run = keptLock.then(async () => { const all = await keptTabs(); const out = await fn(all); await chrome.storage.session.set({ [KEPT]: all }).catch(() => {}); return out; }); keptLock = run.catch(() => {}); return run; };
async function keepTab(frame, key, conversation) {
  const tabId = tabOfFrame(frame);
  dlog('keep', key, tabId);
  await withTabs(async (set) => { set.delete(tabId); });       // not a work tab any more: the driver is done
  const old = await withKept(async (all) => { const prev = all[key]; all[key] = { tabId, conversation, at: now() }; return prev; });
  if (old && old.tabId !== tabId) await chrome.tabs.remove(old.tabId).catch(() => {});
  await place();
}
// The job on screen changed (the panel). Its chat comes into view — its tab moved in, or, when the
// chat has no tab open, opened again (read-only until it gets work); every other ChatGPT tab goes to
// the minimized window.
async function setFocus(key, windowId) {
  dlog('focus', key);
  await chrome.storage.session.set({ [FOCUS]: { key: String(key || ''), windowId: windowId ?? null } }).catch(() => {});
  await place();
  if (!key || !(await state()).enabled) return;
  const busy = Object.values(await read(FRAMES, {})).some((f) => f.lease?.key === key);
  if (busy || (await keptTabs())[key]) return;
  const thread = (await read(K.threads, {}))[key];
  if (!/\/c\//.test(thread?.conversation || '') || thread.stage === 'closing') return;
  await makeRoom();
  const view = await viewWindowId();
  const [cur] = view != null ? await chrome.tabs.query({ active: true, windowId: view }).catch(() => []) : [];
  const tab = await chrome.tabs.create({ url: thread.conversation, active: false, ...(cur ? { windowId: view, index: cur.index + 1 } : {}) }).catch(() => null);
  if (!tab) return;
  dlog('focus-open', key, tab.id);
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const old = await withKept(async (all) => { const prev = all[key]; all[key] = { tabId: tab.id, conversation: thread.conversation, at: now() }; return prev; });
  if (old && old.tabId !== tab.id) await chrome.tabs.remove(old.tabId).catch(() => {});
}
// At most MAX_TABS ChatGPT tabs in all — working tabs AND kept chats. Before a new working tab opens,
// the oldest kept chats' tabs are closed if needed (never the job on screen's). Their chats stay: the
// server still holds them, so "Open Chat" (openChat) opens one again, and questions still go to it.
async function makeRoom() {
  const working = Object.keys(await read(FRAMES, {})).length + ((await state()).checkFrame ? 1 : 0);
  const keep = Math.max(0, MAX_TABS - 1 - working);
  const { key: focus } = await focusNow();
  const hidden = await hiddenWindowId();
  const active = new Set((await chrome.tabs.query({ active: true }).catch(() => [])).filter((t) => t.windowId !== hidden).map((t) => t.id));
  const gone = await withKept(async (all) => {
    // (a chat the bidder is reading right now stays open, and so does the job on screen's)
    const old = Object.entries(all).filter(([k, v]) => !active.has(v.tabId) && k !== focus).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    const out = [];
    while (old.length > keep) { const [k, v] = old.shift(); out.push(v.tabId); delete all[k]; }
    return out;
  });
  for (const tabId of gone) await chrome.tabs.remove(tabId).catch(() => {});
}
// deleteChats: the chats are no use any more (the job is done): each is deleted INSIDE its own tab
// before the tab closes — no extra ChatGPT tab is opened for it — and the server is told.
// keepOne: the ONE ChatGPT tab is not closed when its job is done — it stays (idle) for the next CV,
// so no tab is opened and closed again and again.
const IDLE = 'idle';
async function closeKept(test, { deleteChats = false, keepOne = false } = {}) {
  let idle = null;
  if (keepOne && !(await state()).enabled) keepOne = false;          // disconnected: no tab stays
  const before = Object.keys(await keptTabs());
  const working = keepOne ? (await ourTabs()).size : 1;
  const gone = await withKept(async (all) => {
    const out = [];
    for (const [k, v] of Object.entries(all)) if ((k !== IDLE || !keepOne) && test(k, v)) { out.push(v); delete all[k]; }
    // the last ChatGPT tab stays open, idle — registered at once, so a delete that starts meanwhile uses it
    if (keepOne && out.length && !working && !Object.keys(all).length) {
      idle = [...out].sort((a, b) => (b.at || 0) - (a.at || 0))[0];
      all[IDLE] = { tabId: idle.tabId, conversation: '', at: now() };
    }
    return out;
  });
  if (gone.length) dlog('close-kept', before.join(','), '→', gone.map((v) => v.tabId).join(','), idle ? `idle ${idle.tabId}` : '');
  const done = [];
  for (const v of gone) {
    const id = convId(v.conversation);
    if (deleteChats && id) { const r = await deleteInTab(v.tabId, [id]); if (r) done.push(...r.done); }
    if (v !== idle) await chrome.tabs.remove(v.tabId).catch(() => {});
  }
  if (done.length) await api('/api/gpt/deleted', { done, failed: [] }).catch(() => {});
  if (gone.length) await place();
}
// Hide (= delete) chats from inside an open chatgpt.com tab, with the page's own session — what
// ChatGPT's own "Delete chat" does. null: not possible there (not a ChatGPT page, signed out…).
async function deleteInTab(tabId, ids) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: hideChats, args: [ids] });
    return r?.result || null;
  } catch { return null; }
}
async function hideChats(ids) {   // runs IN the ChatGPT page
  let token = '';
  try { token = (await (await fetch(`${location.origin}/api/auth/session`, { credentials: 'include' })).json())?.accessToken || ''; } catch { /* below */ }
  if (!token) return null;
  const done = [], failed = [];
  for (const id of ids) {
    let ok = false;
    try {
      const r = await fetch(`${location.origin}/backend-api/conversation/${encodeURIComponent(id)}`, { method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ is_visible: false }) });
      ok = r.ok || r.status === 404;   // 404: already gone
    } catch { /* network */ }
    (ok ? done : failed).push(id);
  }
  return { done, failed };
}
// A batch of chats to delete, run in one of our ChatGPT tabs that is open and loaded. false: none.
async function deleteInPlace(lease) {
  const tabs = new Set([...Object.values(await keptTabs()).map((v) => v.tabId), ...(await ourTabs())]);
  for (const tabId of tabs) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status !== 'complete' || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(t.url || '')) continue;
    const r = await deleteInTab(tabId, lease.ids || []);
    if (r) { await api('/api/gpt/deleted', { done: r.done, failed: r.failed }).catch(() => {}); return true; }
  }
  return false;
}
// The panel's "Open Chat": the job's kept tab, or its conversation opened again (and kept).
async function openChat(key) {
  const kept = (await keptTabs())[key];
  if (kept && await chrome.tabs.get(kept.tabId).catch(() => null)) {
    const tab = await chrome.tabs.update(kept.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { ok: true };
  }
  const thread = (await read(K.threads, {}))[key];
  if (!/\/c\//.test(thread?.conversation || '')) return { ok: false, error: 'This CV has no ChatGPT chat any more.' };
  const tab = await chrome.tabs.create({ url: thread.conversation, active: true });
  await withKept(async (all) => { all[key] = { tabId: tab.id, conversation: thread.conversation, at: now() }; });
  return { ok: true };
}
chrome.tabs.onRemoved.addListener((tabId) => {   // the bidder closed a kept tab: just forget it
  withKept(async (all) => { for (const [k, v] of Object.entries(all)) if (v.tabId === tabId) delete all[k]; }).catch(() => {});
});

// Our tabs that are still open (a tab the bidder closed is gone: its work goes back to the queue).
async function liveFrames() {
  const set = await ourTabs();
  const open = new Set((await chrome.tabs.query({}).catch(() => [])).map((t) => t.id));
  return new Set([...set].filter((id) => open.has(id)).map(frameOfTab));
}
// One of our tabs moved to a conversation (ChatGPT opens /c/<id> as soon as the prompt is sent): record
// it on the server at once — the worker sees the URL change instantly, while the driver's own report
// waits for a timer that Chrome slows down in background tabs.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url || !/\/c\/[A-Za-z0-9][A-Za-z0-9_-]{7,}/.test(change.url)) return;
  ourTabs().then((set) => { if (set.has(tabId)) return alive(frameOfTab(tabId), change.url, { fromTab: true }); }).catch((e) => noteError('alive', e));
});
// The bidder closed one of our tabs: its work goes back to the queue (and is picked up again).
chrome.tabs.onRemoved.addListener((tabId) => {
  withTabs(async (set) => set.delete(tabId)).then((ours) => { if (ours) tick(); }).catch(() => {});
});

// ---------- the panel's copy of the server queue ----------
// Server rows → the field names the panel reads.
const toThread = (r) => ({
  key: r.key, profileId: r.profile_id, jobId: r.job_id, company: r.company, jobTitle: r.job_title,
  stage: r.stage, work: r.work, attempts: r.attempts, want: r.want || [], conversation: r.conversation,
  resumeId: r.resume_id, atsScore: r.ats_score, ats: null, error: r.error, updatedAt: r.updated_at,
});
export async function syncMirror() {
  try {
    const { threads = [], to_delete: toDelete = 0 } = await request('/api/gpt/threads');
    await chrome.storage.local.set({ [K.threads]: Object.fromEntries(threads.map((r) => [r.key, toThread(r)])) });
    await noteToDelete(toDelete);
    // A kept chat is done once the server no longer holds that conversation for the job.
    const held = new Map(threads.filter((r) => r.stage !== 'closing').map((r) => [r.key, convId(r.conversation)]));
    await closeKept((key, v) => !held.get(key) || held.get(key) !== convId(v.conversation), { deleteChats: true, keepOne: true });
  } catch (e) { if (e?.status === 401) await chrome.storage.local.set({ [K.threads]: {} }); }
}
async function noteToDelete(n) { if (typeof n === 'number' && (await state()).toDelete !== n) await setState({ toDelete: n }); }

// ---------- the loop ----------
let ticking = false, again = false;
export async function tick() {
  if (ticking) { again = true; return; }
  ticking = true;
  try { do { again = false; await tickOnce(); } while (again); }
  catch (e) { await noteError('tick', e); }
  finally { ticking = false; }
}
// The last thing that went wrong in the background (for diagnosis).
async function noteError(where, e) {
  console.warn(`[gpt] ${where}:`, e);
  await chrome.storage.local.set({ gptLastError: { at: new Date().toISOString(), where, message: String(e?.message || e), stack: String(e?.stack || '').slice(0, 800) } }).catch(() => {});
}

async function tickOnce() {
  const st = await state();
  const live = await liveFrames();
  // 1) This browser's frames: gone (browser restarted) → hand the work back; stuck → it failed.
  const gone = [], stuck = [];
  await frames(async (all) => {
    for (const [id, f] of Object.entries(all)) {
      if (!live.has(id)) { gone.push(f); delete all[id]; continue; }
      const silent = now() - (f.aliveAt || f.startedAt), age = now() - f.startedAt;
      if (age > (WORK_LIMIT_MS[f.lease.work] || WORK_LIMIT_MS.write) || silent > SILENT_LIMIT_MS) { stuck.push({ id, f, why: silent > SILENT_LIMIT_MS ? 'ChatGPT stopped responding.' : 'ChatGPT took too long.' }); delete all[id]; }
    }
  });
  if (gone.length) await release(gone);
  for (const s of stuck) {
    if (s.f.lease?.work !== 'delete') s.f.conversation = s.f.conversation || await taskConversation(s.id, s.f);
    await closeFrame(s.id); await reportFailure(s.f, s.why);
  }
  await flushLegacyChats();

  // Disconnected: no CVs, no answers — only the chats left behind are deleted.
  const deletesOnly = !st.enabled;
  if (deletesOnly) {
    if (live.size) await stopAllWork((f) => f.lease.work === 'delete');
    if (st.status === 'checking' || st.checkFrame) await setState({ status: 'off', checkFrame: '' });
    if (!(await hasChatAccess()) || (st.cooldownUntil && now() < st.cooldownUntil)) { await syncMirror(); return; }
  } else {
    if (st.status === 'needs_login' || st.status === 'needs_plan') return;
    if (st.cooldownUntil && now() < st.cooldownUntil) return;
    if (!(await hasChatAccess())) { await setState({ enabled: false, status: 'off', notice: 'ChatGPT access was removed — connect again.' }); return; }
    // The account check comes first: nothing is written until a paid plan is confirmed.
    if (st.status === 'checking' || (st.cooldownUntil && !st.plan)) { await runCheck(st, live); return; }
    if (st.cooldownUntil || st.status !== 'ok') await setState({ cooldownUntil: 0, status: 'ok', notice: '' });
  }

  // 2) Lease work for the free frames.
  const mine = Object.values(await read(FRAMES, {}));
  const slots = Math.max(0, PARALLEL - mine.length);
  let tasks = [];
  // `active`: what this browser is really working on — the server hands back any other lease of it.
  try {
    const r = await api('/api/gpt/claim', { device: await deviceId(), slots, active: mine.flatMap(keysOf), only_deletes: deletesOnly });
    tasks = r.tasks || [];
    await noteToDelete(r.to_delete);
  } catch (e) { await noteError('claim', e); }
  for (const lease of tasks) await startWork(lease).catch(async (e) => { await noteError('start', e); await release([{ lease }]); });
  await syncMirror();
}
const keysOf = (f) => (f.lease?.keys || (f.lease?.key ? [f.lease.key] : f.keys || (f.key ? [f.key] : [])));
// Work handed back to the server; the conversations its frames had opened are deleted.
async function release(list) {
  if (!list.length) return;
  await api('/api/gpt/release', { keys: list.flatMap(keysOf), chats: list.map((f) => f.conversation).filter(Boolean), device: await deviceId() }).catch(() => {});
}
// Chats an older version (1.1 / 1.2: the queue in the extension) opened and left: the server deletes them.
async function flushLegacyChats() {
  const chats = await read('gptLegacyChats', []);
  if (!chats.length) return;
  try { await api('/api/gpt/trash', { chats, device: await deviceId() }); await chrome.storage.local.remove('gptLegacyChats'); } catch { /* next tick */ }
}

// ---------- the account check (paid plans only) ----------
async function runCheck(st, live) {
  if (st.checkFrame && live.has(st.checkFrame) && now() - (st.checkStartedAt || 0) < CHECK_LIMIT_MS) return;   // still checking
  if (st.checkFrame) await closeFrame(st.checkFrame);   // stuck or gone: check again
  await setState({ status: 'checking', cooldownUntil: 0, notice: '', checkFrame: '' });
  const frame = await openFrame(CHAT_URL, '');                // (in the minimized window)
  await setState({ checkFrame: frame, checkStartedAt: now() });
}
async function finishCheck(frame, res) {
  await closeFrame(frame);
  const kind = res?.ok ? '' : (res?.kind || 'error');
  if (!kind) { await setState({ status: 'ok', plan: res.plan || 'paid', checkFrame: '', notice: '' }); tick().catch(() => {}); return; }
  if (kind === 'needs_login' || kind === 'free_plan' || kind === 'plan_unknown') {
    await noteError(kind, new Error(`${res?.error || kind} ${res?.diag ? JSON.stringify(res.diag) : ''}`));
    await setState({ status: kind === 'needs_login' ? 'needs_login' : 'needs_plan', plan: res?.plan || '', checkFrame: '', notice: PLAN_NOTICE[kind] });
    return;
  }
  if (kind === 'rate_limited') { await setState({ status: 'limited', cooldownUntil: now() + 120_000, checkFrame: '', notice: 'ChatGPT reported a usage limit — waiting 2 minutes.' }); return; }
  await noteError('check', new Error(res?.error || kind));
  await setState({ status: 'checking', checkFrame: '' });   // tried again on the next tick
}

// ---------- running a leased task ----------
// models: { cv, answers } — the model ChatGPT's menu is set to for each (client.js gptModels).
// expect: the chat the page must be on before ChatGPT is sent anything — `chat` (the job's own
// conversation id) or a new chat ('') — the driver refuses any other page (kind wrong_page), so a
// message can never land in another job's chat.
function frameTask(lease, models = {}, url = '') {
  if (lease.work === 'delete') return { kind: 'delete', ids: lease.ids };
  const expect = { chat: convId(url), key: lease.key };
  if (lease.work === 'write') {
    const qs = lease.questions || [];
    return { kind: 'write', prompt: lease.prompt, timeoutMs: TIMEOUT_MIN * 60_000, answersPrompt: qs.length ? answersPrompt(qs) : '', answersCount: qs.length,
      model: models.cv || '', answersModel: models.answers || '', expect: { ...expect, chat: '' } };
  }
  // A new chat for answers (the CV has no chat): it carries the job and the CV (context).
  return { kind: 'answers', prompt: answersPrompt(lease.questions, { context: expect.chat ? '' : (lease.context || '') }), count: lease.questions.length,
    timeoutMs: 3 * 60_000, model: models.answers || '', expect };
}
async function startWork(lease) {
  // Chats to delete: in a ChatGPT tab that is already open, when there is one — no extra tab.
  if (lease.work === 'delete' && await deleteInPlace(lease)) return;
  // Answers go to the CV's own conversation; a CV built by hand has none — a new chat (with the job as context).
  // A new chat starts in the profile's ChatGPT PROJECT when it has one (lease.project_url): there, with
  // "Project-only" memory, the shared account's memory of other profiles stays out.
  const fresh = lease.project_url || CHAT_URL;
  const url = lease.work === 'answer' && /\/c\//.test(lease.conversation || '') ? lease.conversation : fresh;
  // Answers in a chat whose tab is still open on it: asked right there — no page load.
  dlog('start', lease.work, lease.key || '', url.slice(-14));
  if (lease.work === 'answer' && lease.key && await answerInPlace(lease, url)) return;
  if (lease.work === 'answer' && lease.key) await closeKept((key) => key === lease.key);   // one tab per chat
  const models = await gptModels();
  const id = await openFrame(url, lease.key || '');
  await frames(async (all) => { all[id] = { lease, task: frameTask(lease, models, url), startedAt: now(), aliveAt: now() }; });
  await place();
}
async function answerInPlace(lease, url) {
  const kept = (await keptTabs())[lease.key];
  if (!kept || convId(kept.conversation) !== convId(url)) return false;
  const t = await chrome.tabs.get(kept.tabId).catch(() => null);
  if (!t || t.status !== 'complete' || convId(t.url) !== convId(url)) return false;
  await withKept(async (all) => { delete all[lease.key]; });
  await withTabs(async (set) => { set.add(t.id); });
  const id = frameOfTab(t.id);
  const models = await gptModels();
  await frames(async (all) => { all[id] = { lease, task: frameTask(lease, models, url), startedAt: now(), aliveAt: now(), conversation: kept.conversation }; });
  const poked = await chrome.tabs.sendMessage(t.id, { type: 'gpt_poke' }, { frameId: 0 }).then((r) => !!r?.ok).catch(() => false);
  if (!poked) await chrome.tabs.reload(t.id).catch(() => {});   // its driver is gone (the extension updated): load it again
  return true;
}
async function taskFor(frame) {
  if ((await state()).checkFrame === frame) return { id: frame, kind: 'check' };
  const f = (await read(FRAMES, {}))[frame];
  if (!f) return null;
  await frames(async (all) => { if (all[frame]) all[frame].aliveAt = now(); });
  return { id: frame, ...f.task };
}
// A heartbeat; `conversation`: the chat ChatGPT opened for this work — recorded on the server at
// once, so it is deleted even if this frame never finishes.
// Only the task's own chat is taken: the job's chat it was opened on (task.expect.chat), or the new chat
// ChatGPT opened after the driver sent its first message (`sent`) — and once known it is fixed. A tab
// URL seen before that, or another chat later (the bidder clicked one in ChatGPT's sidebar), is not it.
async function alive(frame, conversation, { sent = false, fromTab = false } = {}) {
  const fresh = await frames(async (all) => {
    const f = all[frame]; if (!f) return null;
    f.aliveAt = now();
    if (sent) f.sent = true;
    if (!conversation || conversation === f.conversation || f.lease.work === 'delete') return null;
    const want = f.task?.expect?.chat || '';
    if (want && convId(conversation) !== want) return null;
    if (convId(f.conversation) && convId(f.conversation) !== convId(conversation)) return null;
    if (fromTab && !want && !f.sent) return null;
    f.conversation = conversation;
    return f;
  });
  if (!fresh) return;
  const { lease } = fresh;
  const r = await api('/api/gpt/started', { profile_id: lease.profile_id, job_id: lease.job_id, conversation, device: await deviceId() }).catch(() => null);
  if (r && r.state !== 'ok') {   // the job was applied / skipped meanwhile: stop — the server deletes the chat
    const gone = await frames(async (all) => { const x = all[frame]; delete all[frame]; return x; });
    if (gone) { await closeFrame(frame); await release([gone]); await syncMirror(); }
  }
}

async function reportFailure(f, error) {
  const { lease } = f;
  if (lease.work === 'delete') await api('/api/gpt/deleted', { done: [], failed: lease.ids }).catch(() => {});
  else await api('/api/gpt/fail', { profile_id: lease.profile_id, job_id: lease.job_id, work: lease.work, error, conversation: f.conversation || '', device: await deviceId() }).catch(() => {});
}

// The result is told to the server BEFORE the frame is forgotten: while the report is on its way the
// frame still counts as this browser's work, so a claim sent meanwhile can't take it for an abandoned
// lease (which put the job back in the queue, deleted its fresh chat and wrote the CV a second time).
const finishing = new Set();
async function finish(frame, res) {
  if ((await state()).checkFrame === frame) { await finishCheck(frame, res); return; }
  if (finishing.has(frame)) return;                         // the driver's report came twice
  const f = (await read(FRAMES, {}))[frame];
  if (!f) { await closeFrame(frame); return; }              // stale: stopped meanwhile
  finishing.add(frame);
  try {
    const { lease } = f;
    f.conversation = res?.conversation || f.conversation || '';
    const device = await deviceId();
    const kind = res?.ok ? '' : (res?.kind || 'error');
    dlog('done', lease.work, lease.key || '', kind || 'ok', convId(f.conversation).slice(-12));
    if (!kind && lease.work === 'write') {
      const answers = (res.answers || []).map(cleanAnswer);
      await api('/api/gpt/result', { profile_id: lease.profile_id, job_id: lease.job_id, resume_json: res.resume_json, conversation: f.conversation,
        questions: answers.length ? lease.questions : [], answers, device }).catch((e) => noteError('result', e));
    } else if (!kind && lease.work === 'answer') {
      await api('/api/gpt/answers', { profile_id: lease.profile_id, job_id: lease.job_id, questions: lease.questions,
        answers: (res.answers || []).map(cleanAnswer), conversation: f.conversation, device }).catch((e) => noteError('answers', e));
    } else if (!kind && lease.work === 'delete') {
      await api('/api/gpt/deleted', { done: res.done || [], failed: res.failed || [] }).catch(() => {});
    }
    await frames(async (all) => { delete all[frame]; });
    // A written CV / answers: the chat stays open for the bidder (keepTab). Anything else: closed.
    if (!kind && (lease.work === 'write' || lease.work === 'answer') && lease.key && /\/c\//.test(f.conversation)) await keepTab(frame, lease.key, f.conversation);
    else if (!kind && lease.work === 'delete' && (await state()).enabled && !Object.keys(await keptTabs()).length) await keepTab(frame, IDLE, '');   // the one tab stays for the next CV
    else await closeFrame(frame);
    if (res?.ok && res.plan) await setState({ plan: res.plan });
    if (lease.work === 'delete' && kind === 'needs_login' && !(await state()).enabled) {
      // Disconnected and ChatGPT signed out: try the deletes again later.
      await release([f]);
      await setState({ cooldownUntil: now() + 15 * 60_000 });
    } else if (kind === 'needs_login' || kind === 'free_plan' || kind === 'plan_unknown') {
      // Signed out, or the account is (now) Free: hand everything back and stop until it is fixed.
      await release([f]);
      await stopAllWork();
      await setState({ status: kind === 'needs_login' ? 'needs_login' : 'needs_plan', plan: res?.plan || '', notice: PLAN_NOTICE[kind] });
    } else if (kind === 'wrong_page') {
      // The tab was not on the job's chat (it moved, or ChatGPT sent it elsewhere): nothing was sent —
      // the work goes back to the queue and starts again in a tab of its own.
      await noteError('wrong_page', new Error(`${lease.key}: ${res?.error || ''}`));
      await release([f]);
    } else if (kind === 'rate_limited') {
      await release([f]);
      await setState({ status: 'limited', cooldownUntil: now() + 120_000, notice: 'ChatGPT reported a usage limit — waiting 2 minutes, then it carries on by itself.' });
    } else if (kind) {
      await reportFailure(f, res?.error || kind);
    }
  } finally { finishing.delete(frame); }
  await syncMirror();
  tick().catch(() => {});
}

// The frames of this browser are closed (all, or those keep() does not keep) and their work
// handed back to the server queue.
async function stopAllWork(keep = () => false) {
  const all = await frames(async (a) => { const list = Object.entries(a).filter(([, f]) => !keep(f)); for (const [id] of list) delete a[id]; return list; });
  for (const [id, f] of all) {
    if (f.lease?.work !== 'delete') f.conversation = f.conversation || await taskConversation(id, f);
    await closeFrame(id);
  }
  await release(all.map(([, f]) => f));
}

// ---------- requests from the panel ----------
async function handle(msg) {
  switch (msg.action) {
    case 'connect':
      await ensureDriver();   // access was just granted (the panel asked for it from the click)
      await setState({ enabled: true, status: 'checking', notice: '', cooldownUntil: 0, plan: '', checkFrame: '' }); tick(); return { ok: true };
    case 'disconnect': {
      // Work in progress goes back to the server queue; built CVs and their answers stay. Every
      // ChatGPT chat the queue still keeps is deleted now (a question asked later gets a new chat).
      await stopAllWork();
      const c = (await state()).checkFrame; if (c) await closeFrame(c);
      await setState({ enabled: false, status: 'off', notice: '', checkFrame: '', cooldownUntil: 0 });
      const r = await api('/api/gpt/cleanup', { device: await deviceId() }).catch(() => null);
      await closeKept(() => true, { deleteChats: !!r });   // the server listed them: deleted in their own tabs
      const left = await api('/api/gpt/cleanup', { device: await deviceId() }).catch(() => null);
      if (left || r) await noteToDelete((left || r).to_delete);
      tick(); return { ok: true };
    }
    case 'continue': await setState({ status: 'checking', notice: '', checkFrame: '' }); tick(); return { ok: true };   // check the account again
    case 'sync': tick(); syncMirror().catch(() => {}); return { ok: true };   // the panel changed the queue on the server: claim at once
    case 'openChat': return openChat(String(msg.key || ''));
    case 'focus': await setFocus(String(msg.key || ''), Number.isInteger(msg.windowId) ? msg.windowId : null); return { ok: true };
    default: return { ok: false, error: `Unknown action ${msg.action}` };
  }
}

// Earlier versions kept the queue in the extension (1.1 in tabs, 1.2 in frames): close what they
// left open, hand their conversations to the server to delete, and drop the rest — the server
// queue is the record now. (Their threads have a numeric createdAt; the server mirror does not.)
async function migrateLocalQueue() {
  const old = Object.values(await read(K.threads, {})).filter((t) => typeof t?.createdAt === 'number');
  if (!old.length) return;
  for (const t of old) if (t.tabId != null) await chrome.tabs.remove(t.tabId).catch(() => {});
  const chats = old.map((t) => t.conversation).filter((c) => /\/c\//.test(c || ''));
  if (chats.length) await chrome.storage.local.set({ gptLegacyChats: [...(await read('gptLegacyChats', [])), ...chats] });
  await chrome.storage.local.remove([K.threads]);
}

// ---------- wiring ----------
export function installGptRunner() {
  const alarm = () => chrome.alarms.create('gpt-tick', { periodInMinutes: 0.5 });
  chrome.runtime.onInstalled.addListener(() => { alarm(); migrateLocalQueue().then(() => tick()).catch(() => {}); });
  chrome.runtime.onStartup.addListener(() => { alarm(); tick().catch(() => {}); });   // after a browser restart: carry on
  chrome.alarms.get('gpt-tick').then((a) => { if (!a) alarm(); }).catch(alarm);
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'gpt-tick') tick().catch(() => {}); });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // The driver in a ChatGPT tab asks for its task: ours (opened by this worker) or not (the
    // bidder's own ChatGPT tab — it then does nothing). Tabs are told apart by their tab id.
    if (msg?.type === 'gpt_ready') {
      const tabId = _sender.tab?.id;
      if (tabId == null) { sendResponse({ ours: false, task: null }); return; }
      ourTabs().then(async (set) => {
        if (!set.has(tabId)) return { ours: false, task: null };
        return { ours: true, task: await taskFor(frameOfTab(tabId)) };
      }).then(sendResponse, () => sendResponse({ ours: false, task: null }));
      return true;
    }
    // The driver's pauses (gpt/driver.js sleep): timed here, where Chrome doesn't slow timers down.
    if (msg?.type === 'gpt_sleep') { setTimeout(() => sendResponse({}), Math.max(0, Math.min(Number(msg.ms) || 0, 5000))); return true; }
    if (msg?.type === 'gpt_alive' && msg.frame) { alive(msg.frame, msg.conversation || '', { sent: !!msg.sent }).catch((e) => noteError('alive', e)); return; }
    if (msg?.type === 'gpt_done' && msg.frame) { finish(msg.frame, msg.result).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false })); return true; }
    if (msg?.type === 'gpt') {
      handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
  });
}
