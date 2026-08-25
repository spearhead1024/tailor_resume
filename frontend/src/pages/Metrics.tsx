import { useMemo, useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth, hasRole } from '../lib/auth';

// The admin's chosen set of users to show in the Metrics tables. Persisted so it
// survives navigating away and back (and reloads). `null` (no saved value) means
// "not chosen yet" → show everyone; an explicit list (even empty) is honored.
const USER_FILTER_KEY = 'metrics_selected_users';
function loadUserFilter(): string[] | null {
  try {
    const raw = localStorage.getItem(USER_FILTER_KEY);
    if (raw == null) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : null;
  } catch { return null; }
}
function saveUserFilter(ids: string[] | null) {
  try {
    if (ids == null) localStorage.removeItem(USER_FILTER_KEY);
    else localStorage.setItem(USER_FILTER_KEY, JSON.stringify(ids));
  } catch { /* ignore quota / disabled storage */ }
}

type Cell = { applied: number; total: number };
type Row = {
  user_id: string;
  username: string;
  profile_id: string;
  profile_name: string;
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

function todayIsoMonday(): string {
  // Anchor on today's ET date (the calendar the whole app uses), not the
  // browser's local date — so the week is correct regardless of viewer TZ.
  const etToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [y, m, d] = etToday.split('-').map(Number);
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
      {cell.approved > 0 && <span style={{ color: '#16a34a', marginLeft: 4 }}>✓{cell.approved}</span>}
      {cell.rejected > 0 && <span style={{ color: '#dc2626', marginLeft: 4 }}>✗{cell.rejected}</span>}
    </span>
  );
}

/** Sum applied across profile rows; total = job pool × unique profile count. */
function sumApplied(cells: Cell[]): Cell {
  return {
    applied: cells.reduce((a, c) => a + c.applied, 0),
    total:   (cells[0]?.total ?? 0) * cells.length,
  };
}

/** Per-day version of {@link sumApplied}. */
function aggregateAcrossRows(arrays: Cell[][]): Cell[] {
  if (arrays.length === 0) return [];
  const len = arrays[0].length;
  const out: Cell[] = [];
  for (let i = 0; i < len; i++) {
    out.push({
      applied: arrays.reduce((sum, a) => sum + a[i].applied, 0),
      total:   arrays[0][i].total * arrays.length,
    });
  }
  return out;
}

/** Searchable multi-select of users for the Metrics filter. `selected === null`
 *  means "all users". Picking users produces an explicit id list. */
function UserFilter({ users, selected, onChange }: {
  users: { id: string; name: string }[];
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
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

  const set = new Set(selected ?? users.map((u) => u.id));  // null = all selected
  const allSelected = selected === null || selected.length === users.length;
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = terms.length ? users.filter((u) => terms.every((t) => u.name.toLowerCase().includes(t))) : users;

  const toggle = (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    // Collapse "everything selected" back to null (the all-users sentinel).
    onChange(next.size === users.length ? null : [...next]);
  };
  const count = allSelected ? users.length : (selected?.length ?? 0);
  const label = allSelected ? 'All users' : `${count} of ${users.length} users`;

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
              onClick={() => onChange(null)}>Select all</button>
            <span className="muted">·</span>
            <button className="link" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onClick={() => onChange([])}>Clear</button>
          </div>
          <div className="tz-list">
            {shown.length === 0 && <div className="muted" style={{ padding: 8, fontSize: '0.82rem' }}>No matches</div>}
            {shown.map((u) => (
              <label key={u.id} className="tz-opt" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={set.has(u.id)} onChange={() => toggle(u.id)} />
                {u.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Metrics() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  // Which metric sets this user can see. A dual-role user (bidder + job_adder)
  // and admins see BOTH; others see only the one matching their role.
  const canSeeApps = isAdmin || hasRole(user, 'bidder');
  const canSeeJobs = isAdmin || hasRole(user, 'job_adder');
  const [view, setView] = useState<'apps' | 'jobs'>(canSeeApps ? 'apps' : 'jobs');
  const [weekStart, setWeekStart] = useState<string>(todayIsoMonday());
  // Admin-only user filter. null = all users. Persisted so it survives leaving
  // and returning to the tab.
  const [selectedUserIds, setSelectedUserIds] = useState<string[] | null>(() => loadUserFilter());
  const applyUserFilter = (next: string[] | null) => { setSelectedUserIds(next); saveUserFilter(next); };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['metrics', weekStart],
    queryFn: () => api.get<MetricsResponse>(`/api/metrics?week_start=${weekStart}`),
    refetchInterval: 60_000,
  });

  // Roles per user, so the default filter can exclude admins. Admin-only endpoint;
  // only fetched for admins (the only ones who see the filter).
  const { data: allAppUsers = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<any[]>('/api/users'),
    enabled: isAdmin,
  });
  const isDefaultExcluded = (uid: string, username: string): boolean => {
    if (username === 'intern_bidder') return true;                 // excluded test account
    const u = allAppUsers.find((x: any) => x.id === uid);
    return !!u && (u.is_admin || (u.roles || []).includes('admin'));  // admins excluded by default
  };

  // Group rows by user_id so we can rowSpan the user cell and add per-user
  // subtotal rows when a user has 2+ profiles.
  const allGroups = useMemo(() => {
    const m = new Map<string, { user_id: string; username: string; rows: Row[] }>();
    for (const r of data?.rows || []) {
      let g = m.get(r.user_id);
      if (!g) { g = { user_id: r.user_id, username: r.username, rows: [] }; m.set(r.user_id, g); }
      g.rows.push(r);
    }
    return [...m.values()];
  }, [data]);
  const allJobRows = data?.job_rows || [];

  // Every user that appears in either table — the options for the filter.
  const userOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of allGroups) m.set(g.user_id, g.username);
    for (const r of allJobRows) if (!m.has(r.user_id)) m.set(r.user_id, r.username);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [allGroups, allJobRows]);

  // Smart default (admins only): the FIRST time this admin opens Metrics with no
  // saved selection, pre-select all users EXCEPT admins and intern_bidder. Once a
  // selection exists (from this default or a manual edit) it is left untouched and
  // restored on later visits. `didSeedDefault` guards against re-seeding on refetch.
  const didSeedDefault = useRef(false);
  useEffect(() => {
    if (!isAdmin || didSeedDefault.current) return;
    if (loadUserFilter() !== null) { didSeedDefault.current = true; return; }  // already have a saved choice
    if (userOptions.length === 0 || allAppUsers.length === 0) return;          // wait for data
    const defaults = userOptions.filter((u) => !isDefaultExcluded(u.id, u.name)).map((u) => u.id);
    didSeedDefault.current = true;
    applyUserFilter(defaults.length === userOptions.length ? null : defaults);
  }, [isAdmin, userOptions, allAppUsers]);

  // Apply the admin's saved user filter. null = all users. Non-admins never filter.
  const showUser = (uid: string) => !isAdmin || selectedUserIds === null || selectedUserIds.includes(uid);
  const groups = isAdmin ? allGroups.filter((g) => showUser(g.user_id)) : allGroups;
  const jobRows = isAdmin ? allJobRows.filter((r) => showUser(r.user_id)) : allJobRows;

  // GRAND TOTAL reflects only the visible (selected) users, so it matches the rows
  // on screen rather than the backend's all-users total.
  const appsTotals = useMemo(() => {
    const rows = groups.flatMap((g) => g.rows);
    if (rows.length === 0) return null;
    return { daily: aggregateAcrossRows(rows.map((r) => r.daily)), week: sumApplied(rows.map((r) => r.week)) };
  }, [groups]);
  const jobTotals = useMemo(() => {
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
      lifetime: sumCells(jobRows.map((r) => r.lifetime)),
    };
  }, [jobRows]);

  const isCurrentWeek = weekStart === todayIsoMonday();

  if (isLoading) return <div><span className="spinner" /> Loading metrics…</div>;
  if (!data) return <div className="card"><span className="muted">No metrics data.</span></div>;

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
        {isAdmin && userOptions.length > 0 && (
          <div style={{ marginLeft: 'auto' }}>
            <UserFilter users={userOptions} selected={selectedUserIds} onChange={applyUserFilter} />
          </div>
        )}
        <span className="muted" style={{ fontSize: '0.82rem', marginLeft: isAdmin ? 0 : 'auto' }}>
          {view === 'apps'
            ? 'Each cell = applied / total To-Do'
            : 'Each cell = uploaded ( ✓ approved · ✗ rejected )'}
          {isFetching && <> <span className="spinner" /></>}
        </span>
      </div>

      {/* Applications / Job uploads switch — only when the user can see both */}
      {canSeeApps && canSeeJobs && (
        <div style={{ display: 'flex', gap: 4, marginBottom: '1rem', borderBottom: '1px solid var(--border)' }}>
          {([['apps', '📨 Applications'], ['jobs', '📥 Job uploads']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setView(k)}
              style={{
                background: 'transparent', border: 'none', borderRadius: 0,
                borderBottom: `2px solid ${view === k ? 'var(--accent, #2563eb)' : 'transparent'}`,
                color: view === k ? 'var(--text)' : 'var(--muted)',
                fontWeight: view === k ? 700 : 400, padding: '8px 16px', fontSize: '0.95rem',
              }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Applications table */}
      {view === 'apps' && canSeeApps && (
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="metrics-table">
          <thead>
            <tr>
              {isAdmin && <th>User</th>}
              <th>Profile</th>
              {data.days.map((d) => <th key={d} style={{ textAlign: 'center' }}>{shortDay(d)}</th>)}
              <th style={{ textAlign: 'center' }}>This Week</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={(isAdmin ? 2 : 1) + data.days.length + 1}
                  style={{ padding: '1.5rem', textAlign: 'center' }}>
                  <span className="muted">
                    {isAdmin
                      ? 'No bidder activity yet. Profile assignments + applies will appear here.'
                      : 'You have no profiles assigned to your account.'}
                  </span>
                </td>
              </tr>
            ) : (
              groups.map((g) => {
                const showSubtotal = g.rows.length >= 2;
                const userRowSpan = g.rows.length + (showSubtotal ? 1 : 0);
                const subtotalDaily = aggregateAcrossRows(g.rows.map((r) => r.daily));
                const subtotalWeek = sumApplied(g.rows.map((r) => r.week));
                return (
                  <>
                    {g.rows.map((r, idx) => (
                      <tr key={`${r.user_id}-${r.profile_id}`}>
                        {isAdmin && idx === 0 && (
                          <td rowSpan={userRowSpan} className="metrics-user-cell">
                            {g.username}
                          </td>
                        )}
                        <td>{r.profile_name}</td>
                        {r.daily.map((c, i) => (
                          <td key={i} style={{ textAlign: 'center' }}><CellView cell={c} /></td>
                        ))}
                        <td style={{ textAlign: 'center' }}><CellView cell={r.week} /></td>
                      </tr>
                    ))}
                    {showSubtotal && (
                      <tr key={`${g.rows[0].user_id}-subtotal`} className="metrics-subtotal">
                        <td><em>{g.username} — total</em></td>
                        {subtotalDaily.map((c, i) => (
                          <td key={i} style={{ textAlign: 'center' }}><CellView cell={c} /></td>
                        ))}
                        <td style={{ textAlign: 'center' }}><CellView cell={subtotalWeek} /></td>
                      </tr>
                    )}
                  </>
                );
              })
            )}
          </tbody>
          {isAdmin && appsTotals && groups.length > 0 && (
            <tfoot>
              <tr className="metrics-grand-total">
                <td colSpan={2}><strong>GRAND TOTAL</strong></td>
                {appsTotals.daily.map((c, i) => (
                  <td key={i} style={{ textAlign: 'center' }}><CellView cell={c} /></td>
                ))}
                <td style={{ textAlign: 'center' }}><CellView cell={appsTotals.week} /></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      )}

      {/* Job-uploads table */}
      {view === 'jobs' && canSeeJobs && (
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="metrics-table">
          <thead>
            <tr>
              {isAdmin && <th>User</th>}
              {data.days.map((d) => <th key={d} style={{ textAlign: 'center' }}>{shortDay(d)}</th>)}
              <th style={{ textAlign: 'center' }}>This Week</th>
              <th style={{ textAlign: 'center' }}>All-time</th>
            </tr>
          </thead>
          <tbody>
            {jobRows.length === 0 ? (
              <tr>
                <td colSpan={(isAdmin ? 1 : 0) + data.days.length + 2}
                  style={{ padding: '1.5rem', textAlign: 'center' }}>
                  <span className="muted">No job uploads in this week.</span>
                </td>
              </tr>
            ) : (
              jobRows.map((r) => (
                <tr key={r.user_id}>
                  {isAdmin && <td className="metrics-user-cell">{r.username}</td>}
                  {r.daily.map((c, i) => (
                    <td key={i} style={{ textAlign: 'center' }}><JobCellView cell={c} /></td>
                  ))}
                  <td style={{ textAlign: 'center' }}><JobCellView cell={r.week} /></td>
                  <td style={{ textAlign: 'center' }}><JobCellView cell={r.lifetime} /></td>
                </tr>
              ))
            )}
          </tbody>
          {isAdmin && jobTotals && jobRows.length > 0 && (
            <tfoot>
              <tr className="metrics-grand-total">
                <td><strong>GRAND TOTAL</strong></td>
                {jobTotals.daily.map((c, i) => (
                  <td key={i} style={{ textAlign: 'center' }}><JobCellView cell={c} /></td>
                ))}
                <td style={{ textAlign: 'center' }}><JobCellView cell={jobTotals.week} /></td>
                <td style={{ textAlign: 'center' }}><JobCellView cell={jobTotals.lifetime} /></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      )}
    </div>
  );
}
