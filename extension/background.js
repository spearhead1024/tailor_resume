// Service worker (module). The extension is the docked side panel (Bid / Add job tabs) —
// the panel (panel/panel.js) talks to the API itself via lib/api.js. The worker makes the
// toolbar button open that panel, relays the Autofill shortcut, runs the ChatGPT connection
// (gpt/runner.js — ChatGPT in hidden frames, even while the panel is closed) and restarts a
// "Load unpacked" install into a newer version its updater put on disk (lib/self-update.js).
import { installGptRunner, gptBusy } from './gpt/runner.js';
import { installSelfUpdate } from './lib/self-update.js';

installGptRunner();
installSelfUpdate(gptBusy);   // a "Load unpacked" install restarts into a newer version on disk

// Set at top level so it applies on every service-worker start, not just install.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Autofill shortcut (manifest "commands", default Alt+Shift+F). Open the panel first —
// Chrome only allows sidePanel.open() straight from the key press — then ask it to
// autofill. A panel that was already open gets the message; one that is opening
// picks the request up from session storage when it boots (panel.js).
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'autofill') return;
  if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  chrome.storage.session.set({ pendingAutofill: { at: Date.now(), windowId: tab?.windowId ?? null } })
    .then(() => chrome.runtime.sendMessage({ type: 'autofill' }))
    .catch(() => { /* panel not open yet — it reads pendingAutofill on boot */ });
});
