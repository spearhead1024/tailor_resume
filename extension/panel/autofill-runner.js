// Autofill orchestration for the side panel. The form work itself happens in
// content/autofill.js, injected on demand into every frame of the tab; this module
// drives it: inject → fill → (press Apply and retry on posting pages) → type into
// React dropdowns with real keystrokes → report. Also collects answers to learn.

const SCRIPT = 'content/autofill.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Filling other sites needs access to them. Chrome only shows the prompt from a
// click, so callers must await this FIRST in their click handler. "debugger" lets
// the panel type real keystrokes into React dropdowns (see typeIntoWidgets).
export const requestSiteAccess = () =>
  chrome.permissions.request({ origins: ['<all_urls>'], permissions: ['debugger'] }).catch(() => false);
export const hasSiteAccess = () => chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);

// Run fn(arg) in every frame of the tab (application forms often live in an iframe).
// Returns [{ frameId, result }] for the frames that answered.
async function inAllFrames(tabId, fn, arg) {
  const target = { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: [SCRIPT] });
  // (An `undefined` arg is "unserializable" to Chrome — pass no args at all then.)
  const res = await chrome.scripting.executeScript({ target, func: fn, args: arg === undefined ? [] : [arg] });
  return res.filter((r) => r.result);
}

const inFrame = (tabId, frameId, fn, arg) =>
  chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: fn, args: [arg] }).then((r) => r[0]?.result);

const fillFrames = (tabId, payload) => inAllFrames(tabId, (d) => window.__trAutofill?.fill(d), payload);
const fieldCount = (frames) => frames.reduce((n, f) => n + (f.result.fields || 0), 0);

// React dropdowns (Greenhouse / Ashby / Workday) ignore script-made events, so type
// into them through the DevTools protocol — Chrome treats that as a real keyboard.
// Chrome shows its "started debugging this browser" bar only while this runs.
async function typeIntoWidgets(tabId, pending) {
  const target = { tabId };
  const filled = [], unfilled = [];
  let detached = false;
  const onDetach = (src) => { if (src.tabId === tabId) detached = true; };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    const why = /attached/i.test(e?.message || '') ? 'close DevTools on that tab and try again' : 'Chrome blocked typing into the page';
    return { filled, unfilled: pending.map(asMiss), note: `Dropdowns skipped — ${why}.` };
  }
  chrome.debugger.onDetach.addListener(onDetach);
  const cdp = (method, params) => chrome.debugger.sendCommand(target, method, params);
  const KEYS = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };
  const key = async (k) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: KEYS[k], ...(k === 'Enter' ? { text: '\r' } : {}) });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: KEYS[k] });
  };
  const type = async (text) => {
    for (const ch of text) {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
  };
  let note = '';
  try {
    // The side panel has the focus, not the page — let the page act focused.
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    for (const p of pending) {
      if (detached) { unfilled.push(asMiss(p)); continue; }
      let ok = false;
      try {
        if (await inFrame(tabId, p.frameId, (id) => window.__trAutofill.focusWidget(id), p.id)) {
          if (p.kind === 'listbox') await key('Enter'); else await type(p.value);
          // Wait for the option list (place searches load from the network).
          let pick = { mode: 'wait' };
          for (const t0 = Date.now(); pick?.mode === 'wait' && Date.now() - t0 < (p.location ? 3500 : 1500);) {
            await sleep(200);
            pick = await inFrame(tabId, p.frameId, (id) => window.__trAutofill.pickOption(id), p.id);
          }
          if (pick?.mode === 'keys') {
            for (let i = 0; i < Math.abs(pick.steps); i++) await key(pick.steps > 0 ? 'ArrowDown' : 'ArrowUp');
            await key('Enter');
          } else if (pick?.mode !== 'clicked') await key('Escape');
          await sleep(250);
          ok = await inFrame(tabId, p.frameId, (id) => window.__trAutofill.verify(id), p.id);
        }
      } catch { ok = false; }
      if (ok) filled.push(p.label); else unfilled.push(asMiss(p));
    }
    if (detached) note = 'Dropdowns stopped — the debugging bar was closed. Run Autofill again to finish them.';
  } finally {
    chrome.debugger.onDetach.removeListener(onDetach);
    if (!detached) await chrome.debugger.detach(target).catch(() => {});
  }
  return { filled, unfilled, note };
}
const asMiss = (p) => ({ label: p.label, required: !!p.required });

/** Fill the form open in `tabId`. payload: { values, answers, labels, cv }.
 *  onProgress(report) is called once the plain fields are done (dropdowns take longer). */
export async function autofillTab(tabId, payload, { onProgress } = {}) {
  let frames = await fillFrames(tabId, payload);
  // A posting page: the Apply button was pressed — poll until the form shows up (a new
  // page or an in-page tab), then fill it. Injection fails mid-navigation; just retry.
  if (frames.some((f) => f.result.openedForm)) {
    frames = [];
    for (const t0 = Date.now(); fieldCount(frames) < 2 && Date.now() - t0 < 15000;) {
      await sleep(1000);
      frames = await fillFrames(tabId, { ...payload, noApply: true }).catch(() => []);
    }
  }
  const report = {
    fields: fieldCount(frames),
    filled: frames.flatMap((f) => f.result.filled),
    unfilled: frames.flatMap((f) => f.result.unfilled),
    cv: frames.map((f) => f.result.cv).find((c) => c !== 'none') || 'none',
    note: '',
  };
  const pending = frames.flatMap(({ frameId, result }) => result.pending.map((p) => ({ ...p, frameId })));
  if (pending.length) {
    onProgress?.({ ...report, typing: pending.length });
    const r = await typeIntoWidgets(tabId, pending);
    report.filled.push(...r.filled);
    report.unfilled.push(...r.unfilled);
    report.note = r.note || '';
  }
  return report;
}

/** The form's current answers, for "Remember". */
export async function collectAnswers(tabId) {
  return (await inAllFrames(tabId, () => window.__trAutofill?.collect())).flatMap((r) => r.result);
}
