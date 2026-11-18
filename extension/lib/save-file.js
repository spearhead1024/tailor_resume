// Saving a CV into Downloads (panel/panel.js download()) — its own module so it can be tested alone.

// "<Profile name> resume.pdf" — a name every OS accepts (Windows, macOS, Linux, ChromeOS): no
// \ / : * ? " < > | or control characters, no leading / trailing dots or spaces (Windows drops
// them), not too long. Letters of any language and apostrophes stay.
export function cvPdfName(profileName) {
  const name = String(profileName || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ')
    .trim().replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120).trim();
  return `${name || 'Resume'} resume.pdf`;
}

// chrome.downloads.download, resolved with how it ENDED: 'complete' | 'locked' (the file to
// replace is in use) | 'cancelled' | 'failed'. The download id comes back before the file is
// written, so the outcome is read from downloads.onChanged.
// onAsk(): Chrome opened a Save dialog (its "Ask where to save each file" setting is on).
export function saveFile(opts, onAsk = () => {}) {
  return new Promise((resolve) => {
    let id = null, settled = false, timer = 0;
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => done('complete'), ms); };
    const done = (v) => { if (settled) return; settled = true; chrome.downloads.onChanged.removeListener(onChanged); clearTimeout(timer); resolve(v); };
    function onChanged(d) {
      if (id === null || d.id !== id) return;
      if (d.state?.current === 'complete') done('complete');
      else if (d.state?.current === 'interrupted') {
        const err = String(d.error?.current || '');
        done(err === 'USER_CANCELED' ? 'cancelled' : /^FILE_(ACCESS_DENIED|BLOCKED|FAILED|NO_SPACE|TOO_LARGE|TRANSIENT_ERROR)$/.test(err) ? 'locked' : 'failed');
      }
    }
    // A Save As dialog can stay open for long; a silent save is done in seconds.
    arm(opts.saveAs ? 10 * 60_000 : 30_000);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.download(opts).then((downloadId) => {
      id = downloadId;
      // It may have finished before the listener could see it.
      chrome.downloads.search({ id }).then(([it]) => {
        if (it?.state === 'complete') done('complete');
        else if (it?.state === 'interrupted') onChanged({ id, state: { current: 'interrupted' }, error: { current: it.error } });
      }).catch(() => {});
      // Still nameless after a moment = a Save dialog is waiting for the bidder (silent saves take a
      // name at once): wait for them, and tell them how to make saves automatic.
      setTimeout(() => chrome.downloads.search({ id }).then(([it]) => {
        if (!settled && it?.state === 'in_progress' && !it.filename) { onAsk(); arm(10 * 60_000); }
      }).catch(() => {}), 1500);
    }, (e) => done(/cancel/i.test(e?.message || '') ? 'cancelled' : 'failed'));
  });
}
