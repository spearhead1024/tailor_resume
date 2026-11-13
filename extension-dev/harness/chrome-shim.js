/* chrome.* for extension pages running inside the dev harness (not as an extension):
 * the side panel (/ext/panel/panel.html — injected by serve.py) and the background
 * worker (/harness/bg.html, data-role="bg"). Everything that crosses a boundary —
 * storage, tabs, scripting, messages, alarms — is owned by the harness page
 * (window.parent.__harness), so it survives "Reload panel" like chrome.storage
 * survives closing the real side panel. Content scripts injected into tabs get their
 * own small chrome object from the harness (see harness.js → contentChrome). */
(() => {
  'use strict';
  const H = window.parent && window.parent !== window ? window.parent.__harness : null;
  const role = document.currentScript?.dataset.role === 'bg' ? 'bg' : 'panel';
  if (!H) {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.innerHTML = '<p style="font:14px system-ui;padding:20px;color:#ccc">Open this through the dev harness: <a href="/" style="color:#7ab">/</a></p>';
    });
    return;
  }
  // A new panel inside a harness page loaded before the harness itself was updated: say so
  // instead of failing silently (the fix is to reload the whole page).
  if (typeof H.attach !== 'function' || typeof H.reportError !== 'function') {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.innerHTML = '<div style="font:14px system-ui;padding:20px;color:#fbbf24">The test page is out of date. Press <b>F5</b> to reload the whole page.</div>';
    });
    throw new Error('dev harness out of date — reload the page');
  }
  const me = window;
  H.attach(role, me);
  // Every error is shown in the harness, never a silent blank panel.
  window.addEventListener('error', (e) => H.reportError(role, `${e.message}${e.filename ? ` (${e.filename.replace(location.origin, '')}:${e.lineno})` : ''}`));
  window.addEventListener('unhandledrejection', (e) => H.reportError(role, `unhandled: ${e.reason?.message || e.reason}`));
  // A module that fails to load (404, syntax error in an import) fires on the <script>.
  document.addEventListener('error', (e) => {
    if (e.target?.tagName !== 'SCRIPT') return;
    H.reportError(role, `could not load ${e.target.src.replace(location.origin, '')}`);
    H.scriptFailed?.(role, e.target.src);   // names the failing file (it may be one of its imports)
  }, true);

  const ev = (bucket) => ({
    addListener: (fn) => H.on(bucket, me, fn),
    removeListener: (fn) => H.off(bucket, fn),
    hasListener: (fn) => H.has(bucket, fn),
  });
  // Chrome APIs answer by promise, or by callback when one is passed (with runtime.lastError set on failure).
  const lastErr = { value: undefined };
  const call = (promise, cb) => {
    if (typeof cb !== 'function') return promise;
    promise.then((v) => cb(v), (e) => { lastErr.value = { message: String(e?.message || e) }; try { cb(undefined); } finally { lastErr.value = undefined; } });
    return undefined;
  };
  const area = (name) => ({
    get: (keys, cb) => call(H.store.get(name, keys), cb),
    set: (obj, cb) => call(H.store.set(name, obj), cb),
    remove: (keys, cb) => call(H.store.remove(name, keys), cb),
    clear: (cb) => call(H.store.clear(name), cb),
  });
  const optsCb = (a, b) => (typeof a === 'function' ? [undefined, a] : [a, b]);

  window.chrome = {
    runtime: {
      id: 'dev-harness',
      get lastError() { return lastErr.value; },
      getURL: (p) => `${location.origin}/ext/${String(p).replace(/^\//, '')}`,
      getManifest: () => H.manifest,
      sendMessage: (msg, cb) => call(H.sendMessage(msg, me, { id: 'dev-harness', url: location.href }), cb),
      onMessage: ev('message'),
      onInstalled: ev('installed'),
      onStartup: ev('startup'),
    },
    storage: { local: area('local'), session: area('session'), onChanged: ev('storage') },
    tabs: {
      query: (q, cb) => call(H.tabs.query(q || {}), cb),
      get: (id, cb) => call(H.tabs.get(id), cb),
      create: (props, cb) => call(H.tabs.create(props || {}), cb),
      update: (id, props, cb) => {
        if (typeof id === 'object' && id !== null) { cb = props; props = id; id = undefined; }
        return call(H.tabs.update(id, props || {}), cb);
      },
      remove: (id, cb) => call(H.tabs.remove(id), cb),
      sendMessage: (tabId, msg, a, b) => { const [, cb] = optsCb(a, b); return call(H.tabMessage(tabId, msg), cb); },
      onActivated: ev('tabActivated'),
      onUpdated: ev('tabUpdated'),
      onRemoved: ev('tabRemoved'),
    },
    windows: {
      getCurrent: (a, b) => { const [, cb] = optsCb(a, b); return call(Promise.resolve({ id: 1, focused: true, type: 'normal' }), cb); },
    },
    scripting: { executeScript: (inj, cb) => call(H.executeScript(inj), cb) },
    permissions: {
      contains: (_p, cb) => call(Promise.resolve(true), cb),
      request: (_p, cb) => call(Promise.resolve(true), cb),
    },
    alarms: {
      create: (name, info) => { H.alarmCreate(typeof name === 'string' ? name : '', typeof name === 'string' ? info : name); return Promise.resolve(); },
      get: (name, cb) => call(Promise.resolve(H.alarmGet(name)), cb),
      clear: (name, cb) => call(Promise.resolve(H.alarmClear(name)), cb),
      onAlarm: ev('alarm'),
    },
    downloads: {
      download: (opts, cb) => call(H.download(opts, me), cb),
      search: (_q, cb) => call(Promise.resolve([{ id: 1, state: 'complete' }]), cb),
      onChanged: ev('download'),
    },
    commands: {
      getAll: (cb) => call(Promise.resolve([{ name: 'autofill', description: 'Autofill the application form on this tab', shortcut: 'Alt+Shift+F' }]), cb),
      onCommand: ev('command'),
    },
    debugger: {
      attach: (_t, _v, cb) => call(Promise.reject(new Error('Not available in the dev harness — React dropdowns are typed into only in the real extension.')), cb),
      detach: (_t, cb) => call(Promise.resolve(), cb),
      sendCommand: (_t, _m, _p, cb) => call(Promise.reject(new Error('Not available in the dev harness.')), cb),
      onDetach: ev('debuggerDetach'),
    },
    sidePanel: {
      setPanelBehavior: () => Promise.resolve(),
      open: () => Promise.resolve(),
    },
  };

  // ---- API traffic: logged in the harness; with "Dry run" on, writes are not sent.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const t0 = performance.now();
    const isApi = url.pathname.startsWith('/api/');
    if (isApi) {
      const fake = H.dryRunAnswer(method, url.pathname, init.body);
      if (fake) {
        H.log({ method, path: url.pathname + url.search, status: fake.status, ms: 0, dry: true, note: fake.note });
        if (fake.file) return realFetch(fake.file);   // e.g. the sample PDF of a dry-run CV
        return new Response(JSON.stringify(fake.body), { status: fake.status, headers: { 'Content-Type': 'application/json' } });
      }
    }
    try {
      let res = await realFetch(input, init);
      if (isApi) H.log({ method, path: url.pathname + url.search, status: res.status, ms: Math.round(performance.now() - t0) });
      // A real answer that a dry-run write would have changed (e.g. a job's questions).
      if (isApi && res.ok && H.dryRunPatch) {
        const patched = H.dryRunPatch(method, url.pathname, await res.clone().json().catch(() => null));
        if (patched) res = new Response(JSON.stringify(patched), { status: res.status, headers: { 'Content-Type': 'application/json' } });
      }
      return res;
    } catch (e) {
      if (isApi) H.log({ method, path: url.pathname + url.search, status: 0, ms: Math.round(performance.now() - t0), note: String(e?.message || e) });
      throw e;
    }
  };
})();
