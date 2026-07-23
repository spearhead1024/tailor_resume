/* TailorResume push service worker.
   Shows interview notifications (Windows/OS toasts) delivered via Web Push, and focuses the
   board when one is clicked. Served from the site root (/sw.js) so its scope covers /interviews.

   Sound: a service worker cannot play audio at all, and Windows only ever plays ONE short toast
   sound (and often has even that muted for Chrome). To get an alarm-clock style ring that keeps
   going until the notification is acknowledged, we ask the open page(s) to ring, and tell them to
   stop as soon as the notification is clicked or dismissed. */

// Bump this to force every browser onto a new worker. The byte change is what the browser diffs.
const SW_VERSION = '10-require-interaction';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'version') { e.source && e.source.postMessage({ type: 'sw-version', version: SW_VERSION }); return; }
  // The ringing page asks "is this notification still showing?" every few seconds while it rings —
  // see push.ts. `notificationclose` is NOT reliable on Windows once a toast has auto-collapsed into
  // the Action Center: dismissing it from there often never reaches this service worker at all, so a
  // ring that depended on that event alone just played out its full 60s hard cap regardless of when
  // the person actually closed it ("sound keeps going for exactly 1 minute" was this — the cap, not a
  // delay). Actively checking getNotifications() catches EVERY dismissal path — banner click, X,
  // swipe, Action-Center clear, auto-expiry — the moment it happens, not just the ones that fire an event.
  if (e.data && e.data.type === 'check-ring' && e.data.tag) {
    e.waitUntil((async () => {
      const still = await self.registration.getNotifications({ tag: e.data.tag });
      if (still.length === 0 && e.source) e.source.postMessage({ type: 'notification-sound', action: 'stop' });
    })());
  }
});

async function tellPages(msg) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of wins) c.postMessage(msg);
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'TailorResume';
  // ONLY a scheduled interview reminder rings like an alarm clock: the 90-min creator heads-up, the
  // 60-min caller lead, and the 7pm / 8am digests (they set `alarm`). Anything else — a board edit,
  // an assignment, a status change — must NOT hijack the speakers; it shows and goes quiet.
  const isAlarm = !!data.alarm;
  // A NATIVE Windows notification — the same thing the system's own apps produce.
  //
  // Chrome only hands a notification to the Windows Action Center if it can render it there. The
  // moment you ask for something Windows toasts cannot do, Chrome silently draws its OWN styled
  // popup instead — which no longer looks like a system notification. Two of the three things that
  // trigger that fallback stay absent here:
  //     actions  — buttons on the toast
  //     image    — a large inline picture
  // requireInteraction is the THIRD, and it's now turned back on for alarms specifically (below) — by
  // request: a reminder should sit on screen until you close it, like the system Clock app's own
  // alarms, not quietly slide into the Action Center after a few seconds ("shows and hides" was the
  // complaint). If your Chrome build still falls back to its own styled popup for a requireInteraction
  // toast rather than the native Windows one, that's the tradeoff — persistence over native chrome.
  // Board-change / bell-mark notifications are untouched: brief, native-style, never pinned.
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,               // same tag replaces an earlier toast instead of stacking
    renotify: !!data.tag,                     // ...but a replacement must still re-alert, not land silently
    // Only a scheduled REMINDER (alarm) makes a sound. Board-change / bell-mark notifications are
    // silent by request — they update the bell quietly and never ring or ding.
    silent: !isAlarm,
    // Stay on screen until closed/clicked — only for alarms; a board-change toast still auto-clears.
    requireInteraction: isAlarm,
    data: { url: data.url || '/interviews' },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // A reminder (alarm) RINGS in-app until this system notification is clicked/dismissed (see the
    // notificationclick / notificationclose handlers below, which post 'stop'), 60s cap. Reliable even
    // when Windows won't sound a Chrome toast. Board-change / bell-mark notifications carry no alarm,
    // so they never ring.
    //
    // Ring ONE tab only — the focused one, else any visible one, else the first. Posting 'start' to
    // EVERY open tab (the old behaviour) layered N overlapping chimes when the board was open in
    // several tabs, which is exactly the "double sound" people with more than one tab heard. 'stop'
    // still fans out to ALL tabs (notificationclick/close below), so whichever tab is ringing is
    // silenced no matter where the acknowledgement happens. Preferring the focused/visible tab also
    // picks the one whose audio is most likely unlocked, so the chime actually plays.
    if (isAlarm) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = wins.find((c) => c.focused)
        || wins.find((c) => c.visibilityState === 'visible')
        || wins[0];
      if (target) target.postMessage({ type: 'notification-sound', action: 'start', tag: data.tag || '' });
    }
  })());
});

// Clicked → stop ringing, then bring the board up.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/interviews';
  event.waitUntil((async () => {
    await tellPages({ type: 'notification-sound', action: 'stop' });
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {                     // already have the board open → focus it
      if (c.url.includes(target) && 'focus' in c) return c.focus();
    }
    for (const c of wins) {                      // any app window → navigate it to the board
      if ('focus' in c) { try { await c.navigate(target); } catch (_) {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);   // nothing open → open a tab
  })());
});

// Dismissed (swiped away / "Close") → stop ringing too.
self.addEventListener('notificationclose', (event) => {
  event.waitUntil(tellPages({ type: 'notification-sound', action: 'stop' }));
});
