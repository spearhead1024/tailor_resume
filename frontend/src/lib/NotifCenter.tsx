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
import { subscribeLive } from './board-live';
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
      toast(`${m.title} — ${m.body}`, m.kind === 'reminder' ? 'info' : 'success');
      void load();
    });
  }, [load, toast]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const markRead = async (ids?: string[], kind?: NotifKind) => {
    try {
      const r = await api.post<{ counts: Counts }>('/api/notifications/read',
        ids ? { ids } : kind ? { kind } : {});
      setCounts(r.counts);
      setItems((xs) => xs.map((x) =>
        (ids ? ids.includes(x.id) : kind ? x.kind === kind : true) ? { ...x, read: true } : x));
    } catch { /* ignore */ }
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
            {badge > 0 && (
              <button className="ghost" style={{ fontSize: '0.74rem', padding: '2px 7px' }}
                onClick={() => markRead(undefined, tab || undefined)}>
                Mark {tab ? KIND_META[tab].label.toLowerCase() : 'all'} read
              </button>
            )}
          </div>

          {/* categories */}
          <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            {([['', 'All', counts.unread], ['board', 'Board', counts.board], ['reminder', 'Reminders', counts.reminder]] as const)
              .map(([k, label, n]) => (
                <button key={k || 'all'} className={tab === k ? '' : 'secondary'} onClick={() => setTab(k as '' | NotifKind)}
                  style={{ fontSize: '0.76rem', padding: '3px 10px', borderRadius: 999 }}>
                  {label}{n > 0 && <span style={{ opacity: 0.75, marginLeft: 4 }}>{n}</span>}
                </button>
              ))}
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
