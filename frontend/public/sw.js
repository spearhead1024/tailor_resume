/* TailorResume push service worker.
   Shows interview notifications (Windows/OS toasts) delivered via Web Push, and focuses the
   board when one is clicked. Served from the site root (/sw.js) so its scope covers /interviews. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'TailorResume';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,               // same tag replaces an earlier toast instead of stacking
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || '/interviews' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/interviews';
  event.waitUntil((async () => {
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
