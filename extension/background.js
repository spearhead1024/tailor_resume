// Service worker (module). The extension is the docked side panel (Out Bids / Easy Bids / Add Jobs tabs) —
// the panel (panel/panel.js) talks to the API itself via lib/api.js. The worker makes the
// toolbar button open that panel, runs the ChatGPT connection
// (gpt/runner.js — ChatGPT in its own background tabs, even while the panel is closed) and restarts a
// "Load unpacked" install into a newer version its updater put on disk (lib/self-update.js).
import { installGptRunner, gptBusy } from './gpt/runner.js';
import { installSelfUpdate } from './lib/self-update.js';

installGptRunner();
installSelfUpdate(gptBusy);   // a "Load unpacked" install restarts into a newer version on disk

// Bidders work on LinkedIn's AI job search now: what the old classic-search keeper and the Newest Jobs
// list kept is dropped (1.14.0).
chrome.storage.local.remove(['classicOn', 'classicSearch', 'classicBlocked', 'recentSearch', 'recentOpened']).catch(() => {});

// Set at top level so it applies on every service-worker start, not just install.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
