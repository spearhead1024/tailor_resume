// Service worker. The extension is just the docked Bid side panel now — the
// panel (panel/panel.js) talks to the API itself via lib/api.js — so all the
// worker does is make the toolbar button open that panel.

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
