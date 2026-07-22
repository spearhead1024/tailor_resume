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

/** The applicationServerKey a subscription was created with, as base64url — so we can tell whether
   it still matches the key the server signs with. */
function subscriptionKey(sub: PushSubscription): string {
  const raw = sub.options?.applicationServerKey;
  if (!raw) return '';
  const bytes = new Uint8Array(raw as ArrayBuffer);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Get a subscription that is valid for the server's CURRENT VAPID key, rebuilding it if not.
 *
 * A push subscription is permanently bound to the applicationServerKey it was created with. If the
 * server's VAPID keypair is ever replaced, every existing subscription becomes undeliverable — the
 * push service answers 403 ("credentials do not correspond") and the notification silently never
 * arrives. Re-uploading the same subscription (which is what we used to do) can never fix that, so
 * push would stay dead forever. Detect the mismatch and build a fresh subscription instead.
 */
async function currentSubscription(reg: ServiceWorkerRegistration, key: string): Promise<PushSubscription> {
  let sub = await reg.pushManager.getSubscription();
  if (sub && subscriptionKey(sub) !== key) {
    try { await sub.unsubscribe(); } catch { /* it's dead either way */ }
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBuffer(key),
    });
  }
  return sub;
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
  // `updateViaCache: 'none'` — never let the HTTP cache serve a stale sw.js. Without it a browser can
  // keep running an OLD worker for up to 24 hours, which is why a change to how notifications are
  // built could appear to have no effect at all: the old worker was still the one drawing them.
  // The explicit update() then forces a fresh fetch on every load; the worker calls skipWaiting() +
  // clients.claim(), so a new version takes over immediately rather than waiting for every tab to close.
  const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
  try { await reg.update(); } catch { /* offline — keep the worker we have */ }
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
  const sub = await currentSubscription(reg, key);
  await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
  return { ok: true };
}

/** Keep the backend in sync on load: if permission is already granted, silently (re)register the
   current subscription so a returning caller stays subscribed without clicking anything — and
   rebuild it first if the server's VAPID key no longer matches, which is what makes a key change
   heal itself on the next page load instead of killing push permanently. */
export async function syncPushIfGranted(): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const reg = await registerSW();
    const { key } = await api.get<{ key: string }>('/api/push/vapid-public-key');
    const sub = await currentSubscription(reg, key);
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
   A reminder RINGS a repeated two-tone chime until the system notification is clicked or dismissed
   (the SW tells us to stop), with a hard 60s cap so it can never ring forever. The bell mark / board
   changes never ring (they carry no alarm). Why in-app: the OS plays at most one toast sound and
   often mutes even that for Chrome, and a service worker cannot play audio — so this is the reliable
   alert. The pattern is scheduled up-front on the Web Audio clock (not setInterval, which background
   tabs throttle); closing the context cancels every scheduled beep at once, so "stop" is instant.
   Web Audio needs the page interacted-with once (autoplay). Every tab closed → only the OS sound. */
const RING_GAP_S = 1.5;      // seconds between rings
const RING_MAX_S = 60;       // stop after a minute even if never acknowledged
let ringCtx: AudioContext | null = null;
let ringCap: number | null = null;
let ringPoll: number | null = null;
let suppressStartUntil = 0;   // set by stopRinging — see the note there

/* Cross-tab stop bus. Only ONE tab is told to ring (the service worker elects it), but the person may
 * acknowledge from ANY tab — click the toast, open the bell, hit 🔕 Silence, or just click the page in
 * a different tab. Each of those calls stopRinging() locally; without a bus it would only silence the
 * tab it ran in, leaving the *other* tab (the one actually ringing) chiming on — the "I closed it but
 * the sound keeps going" people with several tabs open hear. So a local stop also broadcasts 'stop',
 * and every tab tears its own ring down on receipt (with the same 2.5s suppress, so a socket notify
 * racing in behind the close can't restart it). */
let ringBus: BroadcastChannel | null = null;
try {
  ringBus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tr-ring') : null;
  if (ringBus) ringBus.onmessage = (e: MessageEvent) => { if (e.data === 'stop') stopRingingLocal(); };
} catch { ringBus = null; }

function teardownRing(): void {
  for (const ev of ['pointerdown', 'keydown']) window.removeEventListener(ev, stopRinging);
  if (ringCap !== null) { window.clearTimeout(ringCap); ringCap = null; }
  if (ringPoll !== null) { window.clearInterval(ringPoll); ringPoll = null; }
  if (ringCtx) { const c = ringCtx; ringCtx = null; void c.close().catch(() => {}); }
}

/** Silence THIS tab's ring (and suppress an immediate restart) without re-broadcasting — used when the
 *  stop arrived over the cross-tab bus, so tabs don't ping-pong 'stop' at each other forever. */
function stopRingingLocal(): void {
  suppressStartUntil = Date.now() + 2500;
  teardownRing();
}

/** Start the alarm ring. Exported so the in-app notification socket can ring too — that path works
 *  even when OS/browser notifications are blocked, as long as a tab is open (no push needed).
 *
 *  `tag` (present only for the OS-push path — the socket path has no system notification to check)
 *  arms an ACTIVE poll: every few seconds, ask the service worker whether that notification is still
 *  showing. `notificationclose` is not reliable on Windows once a toast has auto-collapsed into the
 *  Action Center — dismissing it from there often never reaches the service worker, so a ring relying
 *  on that event alone just played out its full RING_MAX_S cap regardless of when you actually closed
 *  it (the "sound keeps going for exactly a minute" report). Polling catches every dismissal path —
 *  click, X, swipe, Action-Center clear, auto-expiry — within a few seconds of it actually happening. */
export function startRinging(tag?: string): void {
  if (Date.now() < suppressStartUntil) return;   // just stopped → ignore a socket ring racing in behind it
  teardownRing();
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
    // Any interaction acknowledges it → silence the ring. Essential when OS notifications are
    // blocked/off and there is no system notification to close: click anywhere — the toast, the bell,
    // the page. (With OS notifications ON, closing the toast also stops it via the SW handlers.)
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, stopRinging, { once: true });
    if (tag && navigator.serviceWorker?.controller) {
      ringPoll = window.setInterval(() => {
        navigator.serviceWorker.controller?.postMessage({ type: 'check-ring', tag });
      }, 3000);
    }
  } catch { /* audio unavailable — the OS sound is the only fallback */ }
}

/** Stop the ring immediately AND briefly suppress any restart — so a socket `notify` that arrives a
 *  beat after you closed the notification can't re-start the sound ("I closed it but it kept ringing").
 *  Called on OS-notification close/click, any page interaction, bell open, mark-read, and Silence.
 *  Also fans the stop out to every other tab (see ringBus) so acknowledging in one tab silences the
 *  tab that is actually ringing. */
export function stopRinging(): void {
  stopRingingLocal();
  try { ringBus?.postMessage('stop'); } catch { /* bus unavailable — local stop still happened */ }
}

/** Unlock Web Audio on the first user gesture. Browsers keep an AudioContext SUSPENDED until the page
 *  has been interacted with, so a reminder that fires before any click would ring silently. Creating +
 *  resuming a throwaway context on the first pointer/key/touch lifts that block for the whole session,
 *  so every later ring plays. Runs once, then removes its own listeners. */
let audioPrimed = false;
function primeAudio(): void {
  if (audioPrimed) return;
  audioPrimed = true;
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, primeAudio);
  try {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const c = new Ctx();
    void c.resume().finally(() => { void c.close().catch(() => {}); });
  } catch { /* ignore — the ring will still try on its own */ }
}

let soundBound = false;
/** Listen for the service worker telling us to start/stop the notification ring, and arm audio-unlock. */
export function initPushSound(): void {
  if (soundBound || !('serviceWorker' in navigator)) return;
  soundBound = true;
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, primeAudio, { passive: true });
  }
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; action?: string; tag?: string } | null;
    if (d?.type !== 'notification-sound') return;
    if (d.action === 'stop') stopRinging();
    else startRinging(d.tag);
  });
}
