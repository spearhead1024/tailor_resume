/* Notification centre — the bell in the top nav.
 *
 * A toast lives for five seconds. If you were on another page, in another tab, or just looked away,
 * you'd never learn that a call was moved off you. Everything the app tells you is filed here, with
 * an unread count, so nothing can be missed.
 *
 * Two categories, deliberately separate:
 *   Board    — somebody changed something (assigned you, reassigned, updated a status)
 *   Reminders — a scheduled interview is coming up (7pm/8am digests, the lead + creator pings)
 * Mixing them would bury "your interview starts in an hour" under a stream of edit chatter.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { subscribeLive, subscribeLiveState } from './board-live';
import { notifPermission, startRinging, stopRinging } from './push';
import { useToast } from './toast';

export type NotifKind = 'board' | 'reminder';
export type Notif = {
  id: string; kind: NotifKind; title: string; body: string;
  row_id?: string; from?: string; at: string; read: boolean;
};
type Counts = { unread: number; board: number; reminder: number };

const KIND_META: Record<NotifKind, { icon: string; label: string; colour: string }> = {
  board:    { icon: '✎', label: 'Board',     colour: '#3b82f6' },
  reminder: { icon: '⏰', label: 'Reminders', colour: '#a855f7' },
};

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

export default function NotifCenter() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'' | NotifKind>('');
  const [items, setItems] = useState<Notif[]>([]);
  const [counts, setCounts] = useState<Counts>({ unread: 0, board: 0, reminder: 0 });
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: Notif[]; counts: Counts }>('/api/notifications');
      setItems(r.items || []);
      setCounts(r.counts || { unread: 0, board: 0, reminder: 0 });
    } catch { /* not signed in yet, or offline */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The bell is the SINGLE owner of notifications. It is mounted on every page, subscribes to the one
  // shared socket, and is the only place that toasts — the board page used to toast them too, and
  // since the server addresses users (not sockets) the same message arrived on both connections and
  // was shown twice. Toasting here means you're told wherever you are in the app, exactly once.
  useEffect(() => {
    const seen = new Set<string>();
    return subscribeLive((m) => {
      if (m.type !== 'notify') return;
      const key = `${m.title}|${m.body}|${m.row_id ?? ''}`;
      if (seen.has(key)) return;                     // belt-and-braces against any repeat delivery
      seen.add(key);
      window.setTimeout(() => seen.delete(key), 4000);
      // Ring for reminders from the in-app socket — but ONLY when OS notifications aren't granted.
      // When they ARE granted, the service worker rings on the push AND closing the toast stops it;
      // if we also rang here (a beat later, over the socket) we'd RESTART the ring right after the
      // user closed the notification — the "I closed it but sound keeps going" bug. So: OS-on → let
      // the SW own the ring (close stops it); OS-off/blocked → the socket is the only ring path.
      if (m.kind === 'reminder' && notifPermission() !== 'granted') startRinging();
      // A reminder is announced by SOUND alone (by request) — no in-app toast pop-up. It's still
      // filed in the bell (load() below) for anyone who wants to look. Board-change notifications
      // (assignment, feedback replies, …) are unaffected — those still toast, since they carry no
      // sound of their own and would otherwise go unnoticed until the bell is next opened.
      if (m.kind !== 'reminder') toast(`${m.title} — ${m.body}`, 'success');
      void load();
    });
  }, [load, toast]);

  // The live socket has NO REPLAY: a `notify` sent while it was down (e.g. during a backend restart)
  // is lost, and the matching OS push arrives on a SEPARATE path (the push service) — so the ring can
  // fire while the bell badge sits stale until a manual refresh. Keep the bell honest without one:
  //   • reload the instant the socket reconnects (catch up on anything missed while it was down),
  //   • poll on a slow interval as a final safety net (covers a notify that never reached this tab),
  //   • refresh whenever the panel is opened.
  useEffect(() => subscribeLiveState((up) => { if (up) void load(); }), [load]);
  useEffect(() => {
    const id = window.setInterval(() => { void load(); }, 20000);
    return () => window.clearInterval(id);
  }, [load]);
  // Opening the bell to check it IS acknowledging the alarm — silence the ring (no sound just for
  // looking at your notifications). Marking one read does the same (see markRead). The bell itself,
  // its badge and the sync toast never make any sound; only the notification's arrival does.
  useEffect(() => { if (open) { void load(); stopRinging(); } }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const markRead = async (ids?: string[], kind?: NotifKind) => {
    stopRinging();    // acknowledging a reminder here silences the alarm ring — no refresh needed
    try {
      const r = await api.post<{ counts: Counts }>('/api/notifications/read',
        ids ? { ids } : kind ? { kind } : {});
      setCounts(r.counts);
      setItems((xs) => xs.map((x) =>
        (ids ? ids.includes(x.id) : kind ? x.kind === kind : true) ? { ...x, read: true } : x));
    } catch { /* ignore */ }
  };

  // Permanently remove every notification for this user — the inbox grows unbounded over time, so this
  // is the "empty it" action. Confirmed, since it's not undoable.
  const deleteAll = async () => {
    if (items.length === 0) return;
    if (!confirm('Delete all notifications? This cannot be undone.')) return;
    try {
      const r = await api.raw.delete<{ counts: Counts }>('/api/notifications');
      setItems([]);
      setCounts(r.data.counts || { unread: 0, board: 0, reminder: 0 });
    } catch {
      toast('Could not delete notifications', 'error');
    }
  };

  const shown = tab ? items.filter((i) => i.kind === tab) : items;
  const badge = counts.unread;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="ghost" onClick={() => setOpen((o) => !o)}
        title={badge ? `${badge} unread notification${badge === 1 ? '' : 's'}` : 'Notifications'}
        style={{ position: 'relative', padding: '0.3rem 0.55rem', fontSize: '1rem', lineHeight: 1 }}>
        🔔
        {badge > 0 && (
          <span style={{
            position: 'absolute', top: -5, right: -5, minWidth: 17, height: 17, padding: '0 4px',
            borderRadius: 999, background: 'var(--danger)', color: '#fff',
            fontSize: 10, fontWeight: 700, lineHeight: '17px', textAlign: 'center',
            boxShadow: '0 0 0 2px var(--panel)',
          }}>{badge > 99 ? '99+' : badge}</span>
        )}
      </button>

      {open && (
        <div className="card" style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 200,
          width: 'min(400px, calc(100vw - 1.5rem))', padding: 0, overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
            borderBottom: '1px solid var(--border)' }}>
            <strong style={{ fontSize: '0.9rem' }}>Notifications</strong>
            <span style={{ flex: 1 }} />
            {/* An always-available, unmistakable "stop the alarm" — opening the bell already silences
                it, but this also stops a ring that started while the bell was already open. */}
            <button className="ghost" title="Silence the alarm sound" style={{ fontSize: '0.74rem', padding: '2px 7px' }}
              onClick={() => stopRinging()}>
              🔕 Silence
            </button>
            {badge > 0 && (
              <button className="ghost" style={{ fontSize: '0.74rem', padding: '2px 7px' }}
                onClick={() => markRead(undefined, tab || undefined)}>
                Mark {tab ? KIND_META[tab].label.toLowerCase() : 'all'} read
              </button>
            )}
          </div>

          {/* categories */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            {([['', 'All', counts.unread], ['board', 'Board', counts.board], ['reminder', 'Reminders', counts.reminder]] as const)
              .map(([k, label, n]) => (
                <button key={k || 'all'} className={tab === k ? '' : 'secondary'} onClick={() => setTab(k as '' | NotifKind)}
                  style={{ fontSize: '0.76rem', padding: '3px 10px', borderRadius: 999 }}>
                  {label}{n > 0 && <span style={{ opacity: 0.75, marginLeft: 4 }}>{n}</span>}
                </button>
              ))}
            <span style={{ flex: 1 }} />
            {/* Empty the whole inbox — it accumulates unbounded otherwise. */}
            <button className="ghost danger" onClick={deleteAll} disabled={items.length === 0}
              title="Delete all notifications" style={{ fontSize: '0.74rem', padding: '3px 8px', borderRadius: 999 }}>
              🗑 Delete all
            </button>
          </div>

          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {shown.length === 0 && (
              <div className="muted" style={{ padding: '22px 12px', textAlign: 'center', fontSize: '0.84rem' }}>
                Nothing here yet.
              </div>
            )}
            {shown.map((n) => {
              const meta = KIND_META[n.kind] ?? KIND_META.board;
              return (
                <div key={n.id} onClick={() => !n.read && markRead([n.id])}
                  style={{
                    display: 'flex', gap: 10, padding: '10px 12px',
                    borderBottom: '1px solid var(--border)',
                    cursor: n.read ? 'default' : 'pointer',
                    background: n.read ? 'transparent' : 'rgba(59,130,246,0.07)',
                  }}>
                  <span style={{ flex: '0 0 auto', color: meta.colour, fontSize: '0.9rem' }}>{meta.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <strong style={{ fontSize: '0.83rem', fontWeight: n.read ? 500 : 700 }}>{n.title}</strong>
                      <span style={{ flex: 1 }} />
                      <span className="muted" style={{ fontSize: '0.7rem', whiteSpace: 'nowrap' }}>{ago(n.at)}</span>
                    </div>
                    <div className="muted" style={{ fontSize: '0.79rem', marginTop: 2, whiteSpace: 'pre-wrap' }}>{n.body}</div>
                  </div>
                  {!n.read && <span style={{ flex: '0 0 auto', width: 7, height: 7, borderRadius: 999,
                    background: 'var(--accent)', alignSelf: 'center' }} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
