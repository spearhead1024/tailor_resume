/* TailorResume push service worker.
   Shows interview notifications (Windows/OS toasts) delivered via Web Push, and focuses the
   board when one is clicked. Served from the site root (/sw.js) so its scope covers /interviews.

   Sound: a service worker cannot play audio at all, and Windows only ever plays ONE short toast
   sound (and often has even that muted for Chrome). To get an alarm-clock style ring that keeps
   going until the notification is acknowledged, we ask the open page(s) to ring, and tell them to
   stop as soon as the notification is clicked or dismissed. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function tellPages(msg) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of wins) c.postMessage(msg);
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'TailorResume';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,               // same tag replaces an earlier toast instead of stacking
    renotify: !!data.tag,                     // ...but a replacement must still re-alert, not land silently
    silent: false,                            // never suppress the OS notification sound
    requireInteraction: !!data.requireInteraction,   // keep the toast up until it's acknowledged
    data: { url: data.url || '/interviews' },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    await tellPages({ type: 'notification-sound', action: 'start' });   // ring until acknowledged
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
