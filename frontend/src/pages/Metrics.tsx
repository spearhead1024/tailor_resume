import { useMemo, useState, useRef, useEffect } from 'react';
import { useUrlState } from '../lib/urlState';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth, hasRole } from '../lib/auth';

// The admin's set of users to HIDE in the Metrics tables. Persisted so it survives
// navigating away and back (and reloads).
//
// This stores EXCLUDED user ids (not selected ones) on purpose: an include-list goes
// stale — a bidder created AFTER the admin last saved the filter (e.g. remy_1) would
// never be in the saved set and would stay hidden forever. With an exclude-list, any
// user not explicitly hidden shows by default, so new bidders appear automatically.
// v3: admins are no longer hidden by default (their applies and job uploads are part of the
// picture now), so the v2 lists — which hid every admin — are discarded and re-seeded.
const USER_FILTER_KEY = 'metrics_hidden_users_v3';
function loadHiddenUsers(): string[] {
  try {
    const raw = localStorage.getItem(USER_FILTER_KEY);
    if (raw == null) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}
function saveHiddenUsers(ids: string[]) {
  try {
    localStorage.setItem(USER_FILTER_KEY, JSON.stringify(ids));
  } catch { /* ignore quota / disabled storage */ }
}
// One-time cleanup: drop the legacy keys so they can't linger.
try { for (const k of ['metrics_selected_users', 'metrics_hidden_users_v2']) localStorage.removeItem(k); } catch { /* */ }

type Cell = { applied: number; total: number };
type Row = {
  user_id: string;
  username: string;
  profile_id: string;
  profile_name: string;
  assigned: boolean;   // false = not their profile — they applied on it this week anyway (e.g. an admin)
  daily: Cell[];
  week: Cell;
  lifetime: Cell;
};
type JobCell = { uploaded: number; approved: number; rejected: number };
type JobRow = { user_id: string; username: string; daily: JobCell[]; week: JobCell; lifetime: JobCell };
type MetricsResponse = {
  week_start: string;
  week_end: string;
  days: string[];
  rows: Row[];
  totals?: { daily: Cell[]; week: Cell; lifetime: Cell };
  job_rows?: JobRow[];
  job_totals?: { daily: JobCell[]; week: JobCell; lifetime: JobCell };
};

/** Parse a YYYY-MM-DD string as LOCAL midnight (NOT UTC midnight).
 *  Avoids the off-by-one display bug for viewers in negative-UTC timezones. */
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoMonday(d: Date): string {
  const dt = new Date(d);
  const dow = (dt.getDay() + 6) % 7;  // make Mon = 0
  dt.setDate(dt.getDate() - dow);
  return toLocalIso(dt);
}

/** A Metrics day starts at 5pm JST (UTC+9, no DST) = 08:00 UTC and is labelled by the date it
 *  starts on — the server's routers/metrics.py `_metrics_day` uses the same boundary. */
const DAY_START_UTC_MS = 8 * 3600_000;

function todayIsoMonday(): string {
  // Today's Metrics day, not the browser's local date — so the week is the same for every viewer.
  const today = new Date(Date.now() - DAY_START_UTC_MS).toISOString().slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  return isoMonday(new Date(y, m - 1, d));
}

function shiftWeek(weekStart: string, deltaDays: number): string {
  const d = parseLocalDate(weekStart);
  d.setDate(d.getDate() + deltaDays);
  return toLocalIso(d);
}

function shortDay(iso: string): string {
  // Anchor the date at noon ET so rendering in ET can't slip to the previous
  // calendar day for browsers in PT.
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 17));  // 17:00 UTC == 12pm-1pm ET
  return dt.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', day: 'numeric' });
}

function formatRange(start: string, end: string): string {
  const fmt = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 17));
    return dt.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

function CellView({ cell }: { cell: Cell }) {
  const empty = cell.total === 0 && cell.applied === 0;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums', color: empty ? 'var(--muted)' : 'var(--text-soft)' }}>
      <strong style={{ color: cell.applied > 0 ? 'var(--text)' : 'var(--muted)' }}>{cell.applied}</strong>
      <span style={{ color: 'var(--muted)' }}> / {cell.total}</span>
    </span>
  );
}

function JobCellView({ cell }: { cell: JobCell }) {
  const empty = cell.uploaded === 0;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      <strong style={{ color: empty ? 'var(--muted)' : 'var(--text)' }}>{cell.uploaded}</strong>
      {cell.approved > 0 && <span style={{ color: 'var(--metric-ok, #16a34a)', marginLeft: 4 }}>✓{cell.approved}</span>}
      {cell.rejected > 0 && <span style={{ color: 'var(--metric-bad, #dc2626)', marginLeft: 4 }}>✗{cell.rejected}</span>}
    </span>
  );
}

/** Sum applied and to-do pools across profile rows. Each profile has its OWN pool (filtered by
 *  region and tech stack), so pools are summed, never "first pool × row count". */
function sumApplied(cells: Cell[]): Cell {
  return {
    applied: cells.reduce((a, c) => a + c.applied, 0),
    total:   cells.reduce((a, c) => a + c.total, 0),
  };
}

/** Per-day version of {@link sumApplied}. */
function aggregateAcrossRows(arrays: Cell[][]): Cell[] {
  if (arrays.length === 0) return [];
  return arrays[0].map((_, i) => sumApplied(arrays.map((a) => a[i])));
}

/** Rows for a grand total: a profile shared by two bidders appears once per bidder, but its pool
 *  must count once. Keep each profile's pool on its first row and zero it on the others. */
function poolOncePerProfile(rows: Row[]): Row[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    if (!seen.has(r.profile_id)) { seen.add(r.profile_id); return r; }
    return { ...r, daily: r.daily.map((c) => ({ ...c, total: 0 })), week: { ...r.week, total: 0 } };
  });
}

/** Searchable multi-select of users for the Metrics filter. Works on a HIDDEN set:
 *  a checked box = shown (not hidden). `hidden` lists the ids to hide; `onChange`
 *  emits the new hidden list. Users not in `hidden` (incl. brand-new bidders) show. */
function UserFilter({ users, hidden, onChange }: {
  users: { id: string; name: string }[];
  hidden: string[];
  onChange: (nextHidden: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEffect(() => { if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const hiddenSet = new Set(hidden);
  const shownCount = users.filter((u) => !hiddenSet.has(u.id)).length;
  const allShown = shownCount === users.length;
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = terms.length ? users.filter((u) => terms.every((t) => u.name.toLowerCase().includes(t))) : users;

  const toggle = (id: string) => {
    const next = new Set(hiddenSet);
    if (next.has(id)) next.delete(id); else next.add(id);   // toggling a checkbox flips hidden membership
    onChange([...next]);
  };
  const label = allShown ? 'All users' : `${shownCount} of ${users.length} users`;

  return (
    <div ref={ref} className="tz-picker" style={{ display: 'inline-block' }}>
      <button type="button" className="secondary" onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
        <span>👥 {label}</span><span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div className="card tz-menu" style={{ minWidth: 240, right: 0, left: 'auto' }}>
          <input ref={inputRef} className="tz-search" value={q} placeholder="Search users…"
            onChange={(e) => setQ(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, padding: '2px 4px 6px', fontSize: '0.8rem' }}>
            <button className="link" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onClick={() => onChange([])}>Select all</button>
            <span className="muted">·</span>
            <button className="link" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onClick={() => onChange(users.map((u) => u.id))}>Clear</button>
          </div>
          <div className="tz-list">
            {shown.length === 0 && <div className="muted" style={{ padding: 8, fontSize: '0.82rem' }}>No matches</div>}
            {shown.map((u) => (
              <label key={u.id} className="tz-opt" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={!hiddenSet.has(u.id)} onChange={() => toggle(u.id)} />
                {u.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One person's slice of the table: their profile rows (applications) and their job uploads. */
type UserBlock = { user_id: string; username: string; apps: Row[]; jobs: JobRow | null };

export default function Metrics() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  // Which metric groups this user can see. A dual-role user (bidder + job_adder)
  // and admins see BOTH; others see only the one matching their role.
  const showApps = isAdmin || hasRole(user, 'bidder');
  const showJobs = isAdmin || hasRole(user, 'job_adder');
  // The week lives in the URL (lib/urlState) so a refresh keeps it.
  const [weekStart, setWeekStart] = useUrlState('week', todayIsoMonday());
  // Admin-only user filter, stored as the set of HIDDEN user ids (see the note by
  // loadHiddenUsers). Anyone not in this set shows — so a new bidder appears without
  // the admin touching the filter. Persisted across navigation/reloads.
  const [hiddenUserIds, setHiddenUserIds] = useState<string[]>(() => loadHiddenUsers());
  const applyHiddenUsers = (next: string[]) => { setHiddenUserIds(next); saveHiddenUsers(next); };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['metrics', weekStart],
    queryFn: () => api.get<MetricsResponse>(`/api/metrics?week_start=${weekStart}`),
    refetchInterval: 60_000,
  });

  // Who is an admin, for the small "admin" tag by their name. Admin-only endpoint;
  // only fetched for admins (the only ones who see other people's rows).
  const { data: allAppUsers = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<any[]>('/api/users'),
    enabled: isAdmin,
  });
  const adminIds = useMemo(
    () => new Set(allAppUsers.filter((u: any) => u.is_admin || (u.roles || []).includes('admin')).map((u: any) => u.id)),
    [allAppUsers]);

  // One block per person, holding BOTH their applications and their job uploads, so the
  // two read side by side in one table (they used to be two sub-tabs).
  const allBlocks = useMemo(() => {
    const m = new Map<string, UserBlock>();
    const blockOf = (id: string, name: string) => {
      let b = m.get(id);
      if (!b) { b = { user_id: id, username: name, apps: [], jobs: null }; m.set(id, b); }
      return b;
    };
    if (showApps) for (const r of data?.rows || []) blockOf(r.user_id, r.username).apps.push(r);
    if (showJobs) for (const r of data?.job_rows || []) blockOf(r.user_id, r.username).jobs = r;
    return [...m.values()].sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
  }, [data, showApps, showJobs]);

  // Every user in the table — the options for the filter.
  const userOptions = useMemo(
    () => allBlocks.map((b) => ({ id: b.user_id, name: b.username })),
    [allBlocks]);

  // Smart default (admins only): the FIRST time this admin opens Metrics with nothing
  // saved yet, hide the intern_bidder test account. Everyone else — admins included, and
  // any user created later — shows automatically. Once the admin has saved anything (even
  // an empty hidden set), this never re-seeds.
  const didSeedDefault = useRef(false);
  useEffect(() => {
    if (!isAdmin || didSeedDefault.current) return;
    if (localStorage.getItem(USER_FILTER_KEY) != null) { didSeedDefault.current = true; return; }  // already chosen
    if (userOptions.length === 0) return;                                                           // wait for data
    didSeedDefault.current = true;
    applyHiddenUsers(userOptions.filter((u) => u.name === 'intern_bidder').map((u) => u.id));
  }, [isAdmin, userOptions]);

  // Apply the admin's filter: a user shows unless they're in the hidden set. Non-admins never filter.
  const hiddenSet = useMemo(() => new Set(hiddenUserIds), [hiddenUserIds]);
  const blocks = isAdmin ? allBlocks.filter((b) => !hiddenSet.has(b.user_id)) : allBlocks;

  // GRAND TOTAL reflects only the visible (selected) users, so it matches the rows
  // on screen rather than the backend's all-users total.
  const appsTotals = useMemo(() => {
    // Nobody filtered out → the server's totals, which also count a job two people both marked once.
    if (data?.totals && blocks.length === allBlocks.length) return data.totals;
    const rows = poolOncePerProfile(blocks.flatMap((b) => b.apps));
    if (rows.length === 0) return null;
    return { daily: aggregateAcrossRows(rows.map((r) => r.daily)), week: sumApplied(rows.map((r) => r.week)) };
  }, [blocks, allBlocks, data]);
  const jobTotals = useMemo(() => {
    const jobRows = blocks.flatMap((b) => (b.jobs ? [b.jobs] : []));
    if (jobRows.length === 0) return null;
    const days = jobRows[0].daily.length;
    const sumCells = (cells: JobCell[]): JobCell => ({
      uploaded: cells.reduce((a, c) => a + c.uploaded, 0),
      approved: cells.reduce((a, c) => a + c.approved, 0),
      rejected: cells.reduce((a, c) => a + c.rejected, 0),
    });
    return {
      daily: Array.from({ length: days }, (_, i) => sumCells(jobRows.map((r) => r.daily[i]))),
      week: sumCells(jobRows.map((r) => r.week)),
    };
  }, [blocks]);

  const isCurrentWeek = weekStart === todayIsoMonday();

  if (isLoading) return <div><span className="spinner" /> Loading metrics…</div>;
  if (!data) return <div className="card"><span className="muted">No metrics data.</span></div>;

  const nDays = data.days.length;
  const appCols = nDays + 1;                                   // days + This Week
  const jobCols = nDays + 1;                                   // days + This Week
  const leadCols = (isAdmin ? 1 : 0) + (showApps ? 1 : 0);     // User, Profile
  const allCols = leadCols + (showApps ? appCols : 0) + (showJobs ? jobCols : 0);
  const centered = { textAlign: 'center' as const };
  // The first column of the Jobs-added group carries the rule that separates the two groups.
  const jobSec = (i: number) => (showApps && i === 0 ? 'metrics-sec' : undefined);
  const dayHeads = (sec: boolean) => data.days.map((d, i) => (
    <th key={d} className={sec && i === 0 ? 'metrics-sec' : undefined} style={centered}>{shortDay(d)}</th>
  ));
  const jobCells = (r: JobRow | null, rowSpan: number) => r
    ? [...r.daily, r.week].map((c, i) => (
        <td key={`j${i}`} rowSpan={rowSpan} className={jobSec(i)} style={centered}><JobCellView cell={c} /></td>))
    : [<td key="j" rowSpan={rowSpan} colSpan={jobCols} className={jobSec(0)} style={centered}><span className="muted">—</span></td>];

  return (
    <div>
      <h1>Metrics</h1>

      {/* Week navigator */}
      <div className="card" style={{
        padding: '0.7rem 1rem', marginBottom: '1rem',
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <button className="secondary"
          onClick={() => setWeekStart(shiftWeek(weekStart, -7))}>
          ← Previous week
        </button>
        <div style={{ fontWeight: 600, minWidth: 220, textAlign: 'center' }}>
          Week of {formatRange(data.week_start, data.week_end)}
        </div>
        <button className="secondary"
          disabled={isCurrentWeek}
          onClick={() => setWeekStart(shiftWeek(weekStart, 7))}>
          Next week →
        </button>
        <button className="ghost" disabled={isCurrentWeek}
          onClick={() => setWeekStart(todayIsoMonday())}>
          This week
        </button>
        {isFetching && <span className="spinner" />}
        {isAdmin && userOptions.length > 0 && (
          <div style={{ marginLeft: 'auto' }}>
            <UserFilter users={userOptions} hidden={hiddenUserIds} onChange={applyHiddenUsers} />
          </div>
        )}
      </div>

      {/* Applications and job uploads, one table: a person's profile rows on the left, the
          jobs they added on the right (spanning their rows). */}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="metrics-table">
          <thead>
            <tr>
              {isAdmin && <th rowSpan={2}>User</th>}
              {showApps && <th rowSpan={2}>Profile</th>}
              {showApps && (
                <th colSpan={appCols} className="metrics-group-head">
                  📨 Applications<small>applied / total To-Do</small>
                </th>
              )}
              {showJobs && (
                <th colSpan={jobCols} className={`metrics-group-head${showApps ? ' metrics-sec' : ''}`}>
                  📥 Jobs added<small>uploaded ( ✓ approved · ✗ rejected )</small>
                </th>
              )}
            </tr>
            <tr>
              {showApps && <>{dayHeads(false)}<th style={centered}>This Week</th></>}
              {showJobs && <>{dayHeads(showApps)}<th style={centered}>This Week</th></>}
            </tr>
          </thead>
          <tbody>
            {blocks.length === 0 ? (
              <tr>
                <td colSpan={allCols} style={{ padding: '1.5rem', textAlign: 'center' }}>
                  <span className="muted">
                    {isAdmin
                      ? 'No activity yet. Profile assignments, applies and job uploads will appear here.'
                      : showApps ? 'You have no profiles assigned to your account.' : 'No job uploads yet.'}
                  </span>
                </td>
              </tr>
            ) : (
              blocks.map((b) => {
                const showSubtotal = b.apps.length >= 2;
                // Lines this person takes: one per profile (at least one, so the jobs have a row
                // to sit on), plus the subtotal. Without the Applications group, a single line.
                const lines = showApps ? Math.max(1, b.apps.length) + (showSubtotal ? 1 : 0) : 1;
                const userCell = isAdmin && (
                  <td rowSpan={lines} className="metrics-user-cell">
                    {b.username}
                    {adminIds.has(b.user_id) && <span className="metrics-tag">admin</span>}
                  </td>
                );
                const appLine = (i: number) => {
                  if (!showApps) return null;
                  const r = b.apps[i];
                  if (r) return (
                    <>
                      <td title={r.assigned ? undefined : 'Not assigned to this profile — applied on it this week'}>
                        {r.profile_name}
                        {!r.assigned && <span className="metrics-tag">not assigned</span>}
                      </td>
                      {r.daily.map((c, k) => <td key={k} style={centered}><CellView cell={c} /></td>)}
                      <td style={centered}><CellView cell={r.week} /></td>
                    </>
                  );
                  if (b.apps.length === 0) return (
                    <><td><span className="muted">—</span></td>
                      <td colSpan={appCols} style={centered}><span className="muted">—</span></td></>
                  );
                  // The subtotal line (only reached when showSubtotal).
                  const daily = aggregateAcrossRows(b.apps.map((x) => x.daily));
                  return (
                    <>
                      <td><em>{b.username} — total</em></td>
                      {daily.map((c, k) => <td key={k} style={centered}><CellView cell={c} /></td>)}
                      <td style={centered}><CellView cell={sumApplied(b.apps.map((x) => x.week))} /></td>
                    </>
                  );
                };
                return Array.from({ length: lines }, (_, i) => (
                  <tr key={`${b.user_id}-${i}`}
                    className={showSubtotal && i === lines - 1 ? 'metrics-subtotal' : undefined}>
                    {i === 0 && userCell}
                    {appLine(i)}
                    {i === 0 && showJobs && jobCells(b.jobs, lines)}
                  </tr>
                ));
              })
            )}
          </tbody>
          {isAdmin && blocks.length > 0 && (appsTotals || jobTotals) && (
            <tfoot>
              <tr className="metrics-grand-total">
                <td colSpan={leadCols}><strong>GRAND TOTAL</strong></td>
                {showApps && (appsTotals
                  ? <>{appsTotals.daily.map((c, i) => <td key={`a${i}`} style={centered}><CellView cell={c} /></td>)}
                      <td style={centered}><CellView cell={appsTotals.week} /></td></>
                  : <td colSpan={appCols} />)}
                {showJobs && (jobTotals
                  ? [...jobTotals.daily, jobTotals.week].map((c, i) => (
                      <td key={`j${i}`} className={jobSec(i)} style={centered}><JobCellView cell={c} /></td>))
                  : <td colSpan={jobCols} className={jobSec(0)} />)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
