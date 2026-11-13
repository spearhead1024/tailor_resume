// Self-update for a "Load unpacked" install. Chrome never updates such an install by itself,
// but it serves the extension's files straight from its folder: when the Windows updater
// (/api/extension/install-windows.cmd → a scheduled task) has replaced that folder with a new
// version, the manifest on disk no longer matches the running one. Then the extension
// restarts into it — at once if nothing would be lost, otherwise the side panel offers a
// Restart button. (A policy / Web Store install is updated by Chrome; this stays idle there.)

export const UPDATE_KEY = 'updateReady';   // chrome.storage.local: the version waiting on disk, or absent

export async function diskVersion() {
  try { return (await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json()).version || ''; }
  catch { return ''; }
}

// isBusy(): true while work would be lost by a restart (e.g. ChatGPT writing a CV).
export async function checkForUpdate(isBusy) {
  const running = chrome.runtime.getManifest().version;
  const disk = await diskVersion();
  if (!disk || disk === running) { await chrome.storage.local.remove(UPDATE_KEY); return; }
  const panels = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
  if (!panels.length && !(await isBusy())) { chrome.runtime.reload(); return; }
  await chrome.storage.local.set({ [UPDATE_KEY]: disk });   // the panel shows "Restart to update"
}

export function installSelfUpdate(isBusy) {
  const alarm = () => chrome.alarms.create('self-update', { delayInMinutes: 1, periodInMinutes: 10 });
  chrome.runtime.onInstalled.addListener(alarm);
  chrome.runtime.onStartup.addListener(alarm);
  chrome.alarms.get('self-update').then((a) => { if (!a) alarm(); }).catch(alarm);
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'self-update') checkForUpdate(isBusy).catch(() => {}); });
}
