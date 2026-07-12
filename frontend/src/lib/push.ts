/* Web Push subscription flow: register the service worker, ask for notification permission,
   subscribe with the server's VAPID key, and hand the subscription to the backend so it can push
   interview reminders/alerts even when the board tab is closed. */
import { api } from '../api/client';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function notifPermission(): NotificationPermission | 'unsupported' {
  return pushSupported() ? Notification.permission : 'unsupported';
}

async function registerSW(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  return reg;
}

/** Ask permission (if needed), subscribe, and register with the backend. Returns ok + a reason on failure. */
export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) return { ok: false, reason: 'This browser does not support notifications.' };
  if (!window.isSecureContext) return { ok: false, reason: 'Notifications need HTTPS (or localhost).' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    return { ok: false, reason: perm === 'denied'
      ? 'Notifications are blocked. Enable them for this site in your browser settings, then retry.'
      : 'Notification permission was not granted.' };
  }
  const reg = await registerSW();
  const { key } = await api.get<{ key: string }>('/api/push/vapid-public-key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
  return { ok: true };
}

/** Keep the backend in sync on load: if permission is already granted, silently (re)register the
   current subscription so a returning caller stays subscribed without clicking anything. */
export async function syncPushIfGranted(): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const reg = await registerSW();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api.get<{ key: string }>('/api/push/vapid-public-key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    }
    await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
  } catch { /* best-effort */ }
}

export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      try { await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* ignore */ }
      await sub.unsubscribe();
    }
  } catch { /* ignore */ }
}

/** Fire a test notification to this user's own devices (proves the pipeline end-to-end). */
export async function sendTestPush(): Promise<number> {
  const r = await api.post<{ sent: number }>('/api/push/test', {});
  return r.sent ?? 0;
}
