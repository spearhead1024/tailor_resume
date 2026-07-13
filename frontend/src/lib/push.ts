/* Web Push subscription flow: register the service worker, ask for notification permission,
   subscribe with the server's VAPID key, and hand the subscription to the backend so it can push
   interview reminders/alerts even when the board tab is closed. */
import { api } from '../api/client';

/** Decode the base64url VAPID key. Returns an ArrayBuffer — a plain `Uint8Array` no longer satisfies
   `BufferSource` under TS 5.7+ (its buffer widened to ArrayBufferLike). */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
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
      applicationServerKey: urlBase64ToBuffer(key),
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
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBuffer(key) });
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

/* ── notification ring (alarm-clock style) ───────────────────────────────────
   The OS plays at most ONE short toast sound, and often has even that muted for Chrome — and a
   service worker cannot play audio at all. So when the app is open, we ring ourselves: a two-tone
   chime repeated until the notification is clicked or dismissed (the SW tells us to stop), with a
   hard cap so it can never ring forever.

   The whole ring pattern is scheduled up-front on the Web Audio timeline rather than driven by
   setInterval: background tabs throttle timers (down to once a minute), which would break the ring
   in exactly the case that matters — but the audio thread is never throttled. Closing the context
   cancels every scheduled beep at once, which is how "stop" is instant.

   Caveat: with every tab closed, only Windows can make a sound — see the notification settings.  */
const RING_GAP_S = 1.5;      // seconds between rings
const RING_MAX_S = 60;       // stop after a minute even if never acknowledged

let ringCtx: AudioContext | null = null;
let ringCap: number | null = null;

function startRinging(): void {
  stopRinging();
  try {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    ringCtx = ctx;
    void ctx.resume().catch(() => {});   // contexts start suspended until the page has been interacted with

    const beep = (freq: number, at: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
    };

    for (let i = 0; i * RING_GAP_S < RING_MAX_S; i++) {   // schedule every ring now, on the audio clock
      const at = i * RING_GAP_S;
      beep(880, at, 0.18);            // two-tone "ding-dong"
      beep(1320, at + 0.16, 0.24);
    }
    ringCap = window.setTimeout(stopRinging, RING_MAX_S * 1000 + 500);
  } catch { /* audio unavailable — the OS sound is the only fallback */ }
}

/** Stop the ring immediately (closing the context cancels everything still scheduled). */
export function stopRinging(): void {
  if (ringCap !== null) { window.clearTimeout(ringCap); ringCap = null; }
  if (ringCtx) {
    const c = ringCtx;
    ringCtx = null;
    void c.close().catch(() => {});
  }
}

let soundBound = false;
/** Listen for the service worker telling us to start/stop the notification ring. */
export function initPushSound(): void {
  if (soundBound || !('serviceWorker' in navigator)) return;
  soundBound = true;
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; action?: string } | null;
    if (d?.type !== 'notification-sound') return;
    if (d.action === 'stop') stopRinging();
    else startRinging();
  });
}
