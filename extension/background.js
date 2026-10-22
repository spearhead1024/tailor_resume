// Service worker. The extension is just the docked Bid side panel now — the
// panel (panel/panel.js) talks to the API itself via lib/api.js — so all the
// worker does is make the toolbar button open that panel.

// Set at top level so it applies on every service-worker start, not just install.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
