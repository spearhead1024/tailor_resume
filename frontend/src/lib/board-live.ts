/* Live board socket.
 *
 * Why: the board used to be a private copy per tab. Two people editing at once each saved their own
 * copy and the last save won — the other person's work vanished with no warning. This connects every
 * open board to one stream so changes land everywhere immediately, and a cell somebody else is
 * editing is visibly claimed before you can type into it.
 *
 * Granularity is deliberately per-ROW, not per-keystroke: we announce "I'm in this cell" and "this
 * row changed", never a character-by-character feed.
 */
import { getToken } from './auth';

export type LiveMsg =
  | { type: 'locks'; locks: LockInfo[] }
  | { type: 'lock'; row_id: string; col_id: string; user_id: string; label: string }
  | { type: 'unlock'; row_id: string; col_id: string }
  | { type: 'lock_denied'; row_id: string; col_id: string; label: string }
  | { type: 'row'; row: { id: string; cells: Record<string, unknown> } }
  | { type: 'row_delete'; row_id: string }
  | { type: 'schema'; columns: unknown[] }
  /** Somebody's working hours / time zone / meetings / days off changed — re-read /people.
   *  The board caches that list, so without this the calendar shades a week that is no longer true. */
  | { type: 'roster'; user_id?: string }
  | { type: 'notify'; kind?: 'board' | 'reminder'; title: string; body: string; row_id?: string; from?: string }
  | { type: 'pong' };

export type LockInfo = { row_id: string; col_id: string; user_id: string; label: string };

const HEARTBEAT_MS = 4000;    // keeps a held cell lock alive while you're still typing in it
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

export class BoardLive {
  private ws: WebSocket | null = null;
  private retry = RETRY_MIN_MS;
  private timer: number | null = null;
  private beat: number | null = null;
  private closed = false;
  private editing: { row: string; col: string } | null = null;

  constructor(private onMsg: (m: LiveMsg) => void, private onState?: (up: boolean) => void) {}

  connect(): void {
    if (this.closed) return;
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // Same origin → the Vite dev proxy and nginx both forward it; no host to configure.
    const url = `${proto}://${location.host}/api/interviews/live?token=${encodeURIComponent(token)}`;

    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { this.scheduleRetry(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = RETRY_MIN_MS;
      this.onState?.(true);
      // If we reconnected mid-edit, re-claim the cell we were in — otherwise it would look free.
      if (this.editing) this.send({ type: 'edit_start', ...this.ids(this.editing) });
      this.beat = window.setInterval(() => {
        if (this.editing) this.send({ type: 'edit_ping', ...this.ids(this.editing) });
      }, HEARTBEAT_MS);
    };
    ws.onmessage = (e) => {
      try { this.onMsg(JSON.parse(e.data) as LiveMsg); } catch { /* ignore junk */ }
    };
    ws.onclose = () => { this.cleanup(); this.onState?.(false); this.scheduleRetry(); };
    ws.onerror = () => { try { ws.close(); } catch { /* already gone */ } };
  }

  private ids(e: { row: string; col: string }) { return { row_id: e.row, col_id: e.col }; }

  private cleanup() {
    if (this.beat !== null) { window.clearInterval(this.beat); this.beat = null; }
    this.ws = null;
  }

  private scheduleRetry() {
    if (this.closed || this.timer !== null) return;
    // Exponential backoff — a server restart must not turn into a reconnect storm.
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.retry = Math.min(this.retry * 2, RETRY_MAX_MS);
      this.connect();
    }, this.retry);
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(msg)); } catch { /* dropped; the retry loop will recover */ }
    }
  }

  /** I have started editing this cell — claim it so nobody can overwrite me. */
  startEdit(row: string, col: string): void {
    if (this.editing && this.editing.row === row && this.editing.col === col) return;
    this.endEdit();
    this.editing = { row, col };
    this.send({ type: 'edit_start', row_id: row, col_id: col });
  }

  /** I'm done — release it. */
  endEdit(): void {
    if (!this.editing) return;
    this.send({ type: 'edit_end', ...this.ids(this.editing) });
    this.editing = null;
  }

  close(): void {
    this.closed = true;
    this.endEdit();
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    // Close the socket BEFORE cleanup(): cleanup() sets this.ws = null, so doing it first left this
    // line closing `null` and the real socket stayed open. That is the whole logout leak — the socket
    // was authenticated as the user who just signed out, and the next user on the tab inherited it.
    try { this.ws?.close(); } catch { /* already gone */ }
    this.cleanup();
  }
}

/* ── one socket per tab ──────────────────────────────────────────────────────
 * The board page and the notification bell both need this stream. Giving each its own connection
 * meant the server (which addresses users, not sockets) delivered every message TWICE into the same
 * tab — which is exactly how a single assignment produced two notifications.
 *
 * So there is one shared socket, and listeners subscribe to it. It is opened on the first subscriber
 * and deliberately kept open after the last one unsubscribes: navigating between pages must not tear
 * the connection down and immediately rebuild it.
 */
let _client: BoardLive | null = null;
const _subs = new Set<(m: LiveMsg) => void>();
const _stateSubs = new Set<(up: boolean) => void>();

function ensureClient(): void {
  if (_client) return;
  _client = new BoardLive(
    (m) => { _subs.forEach((f) => { try { f(m); } catch { /* one bad listener must not stop the rest */ } }); },
    (up) => { _stateSubs.forEach((f) => { try { f(up); } catch { /* ditto */ } }); },
  );
  _client.connect();
}

export function subscribeLive(fn: (m: LiveMsg) => void): () => void {
  _subs.add(fn);
  ensureClient();
  return () => { _subs.delete(fn); };
}

/** Connected / disconnected transitions.
 *
 * This matters because the stream has NO REPLAY: while the socket is down, every row, delete and
 * schema change is simply missed, and the server never resends them. A tab that reconnects is
 * therefore silently stale — missing rows other people added — until someone reloads the page by
 * hand. (A backend restart under --reload drops every socket, so this is not a rare edge case.)
 * Whoever owns the board data listens here and re-reads it on each (re)connect. */
export function subscribeLiveState(fn: (up: boolean) => void): () => void {
  _stateSubs.add(fn);
  ensureClient();
  return () => { _stateSubs.delete(fn); };
}

/** The shared connection, for sending (edit locks). Null until something has subscribed. */
export function liveClient(): BoardLive | null {
  return _client;
}

/** Drop the shared socket entirely — used on sign-out, so the next user doesn't inherit it. */
export function closeLive(): void {
  _subs.clear();
  _stateSubs.clear();
  _client?.close();
  _client = null;
}
