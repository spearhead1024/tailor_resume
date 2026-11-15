// Hidden ChatGPT frames (one per job being written). The service worker (gpt/runner.js)
// asks for them by message; the driver inside each frame (gpt/driver.js) finds its task by
// the frame's name. A real size keeps ChatGPT's layout (and the driver's visibility checks)
// working although nothing is on screen.
'use strict';
const frames = new Map();   // id → <iframe>

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'gpt-offscreen') return;
  if (msg.type === 'open') {
    frames.get(msg.id)?.remove();
    const f = document.createElement('iframe');
    f.name = msg.id;                       // the driver reads window.name to ask for its task
    f.src = msg.url;
    f.width = '1280'; f.height = '900';
    f.allow = 'clipboard-read; clipboard-write';
    document.body.appendChild(f);
    frames.set(msg.id, f);
    sendResponse({ ok: true });
  } else if (msg.type === 'close') {
    frames.get(msg.id)?.remove();
    frames.delete(msg.id);
    sendResponse({ ok: true, left: frames.size });
  } else if (msg.type === 'list') {
    sendResponse({ ok: true, ids: [...frames.keys()] });
  }
});
