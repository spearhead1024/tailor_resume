import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth, hasRole } from '../lib/auth';

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

export default function Metrics() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  // Which metric sets this user can see. A dual-role user (bidder + job_adder)
  // and admins see BOTH; others see only the one matching their role.
  const canSeeApps = isAdmin || hasRole(user, 'bidder');
  const canSeeJobs = isAdmin || hasRole(user, 'job_adder');
  const [view, setView] = useState<'apps' | 'jobs'>(canSeeApps ? 'apps' : 'jobs');
  const [weekStart, setWeekStart] = useState<string>(todayIsoMonday());

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['metrics', weekStart],
    queryFn: () => api.get<MetricsResponse>(`/api/metrics?week_start=${weekStart}`),
    refetchInterval: 60_000,
  });

  // Group rows by user_id so we can rowSpan the user cell and add per-user
  // subtotal rows when a user has 2+ profiles.
  const groups = useMemo(() => {
    const m = new Map<string, { username: string; rows: Row[] }>();
    for (const r of data?.rows || []) {
      let g = m.get(r.user_id);
      if (!g) { g = { username: r.username, rows: [] }; m.set(r.user_id, g); }
      g.rows.push(r);
    }
    return [...m.values()];
  }, [data]);

  const jobRows = data?.job_rows || [];
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
        <span className="muted" style={{ fontSize: '0.82rem', marginLeft: 'auto' }}>
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
          {isAdmin && data.totals && groups.length > 0 && (
            <tfoot>
              <tr className="metrics-grand-total">
                <td colSpan={2}><strong>GRAND TOTAL</strong></td>
                {data.totals.daily.map((c, i) => (
                  <td key={i} style={{ textAlign: 'center' }}><CellView cell={c} /></td>
                ))}
                <td style={{ textAlign: 'center' }}><CellView cell={data.totals.week} /></td>
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
          {isAdmin && data.job_totals && jobRows.length > 0 && (
            <tfoot>
              <tr className="metrics-grand-total">
                <td><strong>GRAND TOTAL</strong></td>
                {data.job_totals.daily.map((c, i) => (
                  <td key={i} style={{ textAlign: 'center' }}><JobCellView cell={c} /></td>
                ))}
                <td style={{ textAlign: 'center' }}><JobCellView cell={data.job_totals.week} /></td>
                <td style={{ textAlign: 'center' }}><JobCellView cell={data.job_totals.lifetime} /></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      )}
    </div>
  );
}
