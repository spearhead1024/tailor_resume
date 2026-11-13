/* ChatGPT connection — the extension's WORKER (imported by background.js).
 *
 * The queue lives on the SERVER (/api/gpt, table cv_queue): which jobs get a CV written ahead
 * (the job on screen + the next 2), which questions to answer, which ChatGPT conversations to
 * delete. Nothing finished is lost when the browser closes — the server builds the CV the moment
 * ChatGPT's JSON arrives, and a lease that runs out (a closed browser) puts unfinished work back
 * in the queue. This worker only:
 *   claim     leases work for its free hidden frames (PARALLEL)
 *   run       one hidden chatgpt.com frame per task in the offscreen document (no tab, no window;
 *             gpt/offscreen.*), a session declarativeNetRequest rule lets chatgpt.com load there,
 *             gpt/driver.js does the work inside and reports back
 *   report    started (a conversation ChatGPT just opened) / result (→ the server builds the CV) /
 *             answers / fail / release / deleted
 *   mirror    the bidder's queue rows into chrome.storage (gptThreads), so the panel redraws
 *
 * ChatGPT conversations are deleted, not just left: the server records every conversation the
 * moment it opens and hands this worker batches of chats to delete (the job applied / skipped,
 * a failed or re-written CV, a closed browser, Disconnect, 2 hours idle). Deleting goes on while
 * disconnected too — then that is the only thing it does.
 *
 * Paid ChatGPT only. Connecting (and Continue) first checks the account in a hidden frame
 * (status 'checking'); the Free plan — or a plan that can't be confirmed — stops all work
 * (status 'needs_plan'). The driver checks again before every CV / answers.
 * status: off | checking | ok | needs_login | needs_plan | limited
 *
 * Local state (chrome.storage.local): gptState (connection; toDelete = chats waiting to be
 * deleted), gptFrames (this browser's frames, their leased tasks and the conversation each one
 * opened), gptDevice (this browser's id), gptThreads (the mirror), gptLegacyChats (chats an
 * older version left, until the server has them). */

import { request } from '../lib/api.js';
import { GPT_KEYS as K, CHAT_ORIGINS, CHAT_URL, PARALLEL } from './client.js';
import { answersPrompt, cleanAnswer } from './prompts.js';

const TIMEOUT_MIN = 6;                  // ChatGPT's answer to the CV prompt
// How long a frame may work before it is given up (within the server's lease).
const WORK_LIMIT_MS = { write: (TIMEOUT_MIN + 4) * 60_000, answer: 5 * 60_000, delete: 3 * 60_000 };
const SILENT_LIMIT_MS = 2 * 60_000;     // a frame whose driver stopped reporting (crashed / never started)
const CHECK_LIMIT_MS = 90_000;          // the account check
const OFFSCREEN = 'gpt/offscreen.html';
const DRIVER_ID = 'tr-gpt-driver';
const FRAME_RULE_ID = 9001;
const FRAMES = 'gptFrames';

const now = () => Date.now();
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

// ---------- hidden ChatGPT frames ----------
let offscreenBusy = null;
async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
  return ctx.length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  offscreenBusy ||= chrome.offscreen.createDocument({
    url: OFFSCREEN, reasons: ['IFRAME_SCRIPTING'],
    justification: 'Runs ChatGPT in hidden frames to write CVs and answer application questions without opening tabs.',
  }).catch((e) => { if (!/single offscreen|already/i.test(e?.message || '')) throw e; }).finally(() => { offscreenBusy = null; });
  await offscreenBusy;
}
const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: 'gpt-offscreen', ...msg });
// chatgpt.com refuses to be framed (X-Frame-Options / CSP frame-ancestors). Drop those headers —
// only for frames this extension loads (no tab: TAB_ID_NONE), never in the user's own tabs.
async function ensureFrameRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [FRAME_RULE_ID],
    addRules: [{
      id: FRAME_RULE_ID, priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ] },
      condition: { requestDomains: ['chatgpt.com', 'chat.openai.com'], resourceTypes: ['sub_frame'], tabIds: [chrome.tabs.TAB_ID_NONE] },
    }],
  });
}
// The driver is a content script for chatgpt.com — registered only once access was granted.
export async function ensureDriver() {
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [DRIVER_ID] }).catch(() => []);
  if (have.length) return;
  await chrome.scripting.registerContentScripts([{
    id: DRIVER_ID, matches: CHAT_ORIGINS, js: ['gpt/driver.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true,
  }]);
}
async function openFrame(url) {
  await ensureDriver(); await ensureFrameRule(); await ensureOffscreen();
  const id = `trgpt-${now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  await toOffscreen({ type: 'open', id, url });
  return id;
}
async function closeFrame(id) {
  if (!id || !(await hasOffscreen())) return;
  const r = await toOffscreen({ type: 'close', id }).catch(() => null);
  if (r && r.left === 0) await chrome.offscreen.closeDocument().catch(() => {});   // nothing left to run
}
async function liveFrames() {
  if (!(await hasOffscreen())) return new Set();
  const r = await toOffscreen({ type: 'list' }).catch(() => null);
  return new Set(r?.ids || []);
}

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
  for (const s of stuck) { await closeFrame(s.id); await reportFailure(s.f, s.why); }
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
  const frame = await openFrame(CHAT_URL);
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
function frameTask(lease) {
  if (lease.work === 'delete') return { kind: 'delete', ids: lease.ids };
  if (lease.work === 'write') {
    const qs = lease.questions || [];
    return { kind: 'write', prompt: lease.prompt, timeoutMs: TIMEOUT_MIN * 60_000, answersPrompt: qs.length ? answersPrompt(qs) : '', answersCount: qs.length };
  }
  return { kind: 'answers', prompt: answersPrompt(lease.questions, { context: lease.context || '' }), count: lease.questions.length, timeoutMs: 3 * 60_000 };
}
async function startWork(lease) {
  // Answers go to the CV's own conversation; a CV built by hand has none — a new chat (with the job as context).
  const url = lease.work === 'answer' && /\/c\//.test(lease.conversation || '') ? lease.conversation : CHAT_URL;
  const id = await openFrame(url);
  await frames(async (all) => { all[id] = { lease, task: frameTask(lease), startedAt: now(), aliveAt: now() }; });
}
async function taskFor(frame) {
  if ((await state()).checkFrame === frame) return { id: 'check', kind: 'check' };
  const f = (await read(FRAMES, {}))[frame];
  if (!f) return null;
  await frames(async (all) => { if (all[frame]) all[frame].aliveAt = now(); });
  return { id: frame, ...f.task };
}
// A heartbeat; `conversation`: the chat ChatGPT opened for this work — recorded on the server at
// once, so it is deleted even if this frame never finishes.
async function alive(frame, conversation) {
  const fresh = await frames(async (all) => {
    const f = all[frame]; if (!f) return null;
    f.aliveAt = now();
    if (!conversation || conversation === f.conversation || f.lease.work === 'delete') return null;
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

async function finish(frame, res) {
  if ((await state()).checkFrame === frame) { await finishCheck(frame, res); return; }
  const f = await frames(async (all) => { const x = all[frame]; delete all[frame]; return x; });
  await closeFrame(frame);
  if (!f) return;   // stale: stopped meanwhile
  const { lease } = f;
  f.conversation = res?.conversation || f.conversation || '';
  const device = await deviceId();
  const kind = res?.ok ? '' : (res?.kind || 'error');
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
  } else if (kind === 'rate_limited') {
    await release([f]);
    await setState({ status: 'limited', cooldownUntil: now() + 120_000, notice: 'ChatGPT reported a usage limit — waiting 2 minutes, then it carries on by itself.' });
  } else if (kind) {
    await reportFailure(f, res?.error || kind);
  } else if (lease.work === 'write') {
    const answers = (res.answers || []).map(cleanAnswer);
    await api('/api/gpt/result', { profile_id: lease.profile_id, job_id: lease.job_id, resume_json: res.resume_json, conversation: f.conversation,
      questions: answers.length ? lease.questions : [], answers, device }).catch((e) => noteError('result', e));
  } else if (lease.work === 'answer') {
    await api('/api/gpt/answers', { profile_id: lease.profile_id, job_id: lease.job_id, questions: lease.questions,
      answers: (res.answers || []).map(cleanAnswer), conversation: f.conversation, device }).catch((e) => noteError('answers', e));
  } else if (lease.work === 'delete') {
    await api('/api/gpt/deleted', { done: res.done || [], failed: res.failed || [] }).catch(() => {});
  }
  await syncMirror();
  tick().catch(() => {});
}

// The frames of this browser are closed (all, or those keep() does not keep) and their work
// handed back to the server queue.
async function stopAllWork(keep = () => false) {
  const all = await frames(async (a) => { const list = Object.entries(a).filter(([, f]) => !keep(f)); for (const [id] of list) delete a[id]; return list; });
  for (const [id] of all) await closeFrame(id);
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
      if (r) await noteToDelete(r.to_delete);
      tick(); return { ok: true };
    }
    case 'continue': await setState({ status: 'checking', notice: '', checkFrame: '' }); tick(); return { ok: true };   // check the account again
    case 'sync': await syncMirror(); tick(); return { ok: true };   // the panel changed the queue on the server
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
    if (msg?.type === 'gpt_ready' && msg.frame) { taskFor(msg.frame).then((task) => sendResponse({ task }), () => sendResponse({ task: null })); return true; }
    if (msg?.type === 'gpt_alive' && msg.frame) { alive(msg.frame, msg.conversation || '').catch((e) => noteError('alive', e)); return; }
    if (msg?.type === 'gpt_done' && msg.frame) { finish(msg.frame, msg.result).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false })); return true; }
    if (msg?.type === 'gpt') {
      handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
  });
}
