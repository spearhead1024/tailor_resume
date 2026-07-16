import { useState, useEffect, useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { etDateTime } from '../lib/etTime';
import SourceBadge from '../lib/SourceBadge';

type Row = {
  saved_resume_id: string;
  job_id: string;
  job_company: string;
  job_title: string;
  job_link: string;
  job_region: string;
  profile_id: string;
  profile_name: string;
  bidder: string;
  applied_at: string;
  created_at: string;
  source?: string;
};
type SearchResp = {
  results: Row[];
  total: number;
  page: number;
  page_size: number;
  profiles: { id: string; name: string }[];
  bidders: string[];
};
type JobDetail = {
  job_id: string; company: string; job_title: string; link: string;
  region: string; status: string; description: string; job_exists: boolean;
};

export default function Applied() {
  const toast = useToast();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [profileId, setProfileId] = useState('');
  const [bidder, setBidder] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => { setPage(1); }, [debounced, profileId, bidder, dateFrom, dateTo, pageSize]);

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (debounced) sp.set('q', debounced);
    if (profileId) sp.set('profile_id', profileId);
    if (bidder) sp.set('bidder', bidder);
    if (dateFrom) sp.set('date_from', dateFrom);
    if (dateTo) sp.set('date_to', dateTo);
    sp.set('page', String(page));
    sp.set('page_size', String(pageSize));
    return sp.toString();
  }, [debounced, profileId, bidder, dateFrom, dateTo, page, pageSize]);

  const { data, isFetching } = useQuery({
    queryKey: ['applied', 'search', params],
    queryFn: () => api.get<SearchResp>(`/api/resumes/search?${params}`),
    placeholderData: keepPreviousData,
  });

  const rows = data?.results || [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  async function viewPdf(id: string) {
    try {
      const res = await api.raw.get(`/api/resumes/${id}/pdf`, { responseType: 'blob' });
      const blob = res.data as Blob;
      if (!blob || blob.size === 0) throw new Error('Empty PDF');
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (e: any) {
      // A VPS_1 resume that couldn't be fetched comes back as 409 with a public VPS_1 link — open it.
      let detail: any;
      try { detail = JSON.parse(await e?.response?.data?.text())?.detail; } catch { /* */ }
      const vps1Url = detail && typeof detail === 'object' ? detail.vps1_resume_url : undefined;
      if (vps1Url) { window.open(vps1Url, '_blank', 'noopener'); return; }
      toast((typeof detail === 'string' && detail) || 'Failed to open PDF', 'error');
    }
  }

  // Schedule → pull this application's resume + job description into a new row on the Interviews board.
  async function scheduleInterview(r: Row) {
    try {
      const jd = await api.get<JobDetail>(`/api/resumes/${r.saved_resume_id}/job`).catch(() => null);
      await api.post('/api/interviews/rows', {
        cells: {
          c_title: r.job_title || '',
          c_account: r.profile_name || '',
          c_resume: `/api/resumes/${r.saved_resume_id}/pdf`,   // downloadable resume link (see ResumeCell)
          c_jd: (jd?.description || '').trim(),
        },
      });
      toast('Added to the Interviews board', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to schedule interview', 'error');
    }
  }

  function clearFilters() {
    setQuery(''); setProfileId(''); setBidder(''); setDateFrom(''); setDateTo('');
  }
  const hasFilters = !!(query || profileId || bidder || dateFrom || dateTo);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>Applied resumes</h1>
        {isFetching && <span className="spinner" />}
        <span className="muted" style={{ fontSize: '0.85rem' }}>{total} applied</span>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Search company, title, description, bidder…" value={query}
          onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 280, flex: '1 1 280px', maxWidth: 380 }} />
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All profiles</option>
          {(data?.profiles || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={bidder} onChange={(e) => setBidder(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="">All bidders</option>
          {(data?.bidders || []).map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <label style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Applied</label>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ maxWidth: 150 }} title="From (ET)" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ maxWidth: 150 }} title="To (ET)" />
        {hasFilters && <button className="secondary" onClick={clearFilters} style={{ fontSize: '0.82rem' }}>Clear</button>}
      </div>

      {/* Pagination top */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {totalPages > 1 && (
          <>
            <button className="secondary" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>← Prev</button>
            <span className="muted" style={{ fontSize: '0.9rem' }}>Page {safePage} of {totalPages}</span>
            <button className="secondary" disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>Next →</button>
          </>
        )}
        <span className="muted" style={{ fontSize: '0.85rem', marginLeft: totalPages > 1 ? 8 : 0 }}>{total} result{total === 1 ? '' : 's'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="muted" style={{ fontSize: '0.8rem' }}>Rows</span>
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} style={{ width: 'auto', padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}>
            {[25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card"><span className="muted">No applied resumes match the filters.</span></div>
      ) : (
        <table>
          <thead>
            <tr><th>Source</th><th>Company</th><th>Title</th><th>Profile</th><th>Bidder</th><th style={{ whiteSpace: 'nowrap' }}>Applied (ET)</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <RowView
                key={r.saved_resume_id}
                row={r}
                open={expanded === r.saved_resume_id}
                onToggle={() => setExpanded(expanded === r.saved_resume_id ? null : r.saved_resume_id)}
                onPdf={() => viewPdf(r.saved_resume_id)}
                onJump={() => navigate(`/jobs?company=${encodeURIComponent(r.job_company)}`)}
                onSchedule={() => scheduleInterview(r)}
              />
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: '1rem' }}>
          <button className="secondary" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>← Prev</button>
          <span className="muted" style={{ fontSize: '0.9rem' }}>Page {safePage} of {totalPages}</span>
          <button className="secondary" disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}

function RowView({ row, open, onToggle, onPdf, onJump, onSchedule }: {
  row: Row; open: boolean; onToggle: () => void; onPdf: () => void; onJump: () => void; onSchedule: () => Promise<void>;
}) {
  const [scheduling, setScheduling] = useState(false);
  const remote = row.source === 'VPS_1';
  const { data: detail, isLoading } = useQuery({
    queryKey: ['applied', 'job', row.saved_resume_id],
    queryFn: () => api.get<JobDetail>(`/api/resumes/${row.saved_resume_id}/job`),
    enabled: open,   // works for VPS_1 rows too — the backend serves their detail from the mirror
  });

  return (
    <>
      <tr style={{ cursor: 'pointer' }} onClick={onToggle}>
        <td><SourceBadge source={row.source} /></td>
        <td>{row.job_company || '—'}</td>
        <td>{row.job_link
          ? <a href={row.job_link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{row.job_title}</a>
          : row.job_title}</td>
        <td>{row.profile_name || '—'}</td>
        <td>{row.bidder || '—'}</td>
        <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>{etDateTime(row.applied_at || row.created_at)}</td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {/* PDF works for both: a VPS_1 resume streams through the backend, falling back to VPS_1's
              public link if it can't be fetched. Job opens the local Jobs tab (VPS_2) or the posting
              (VPS_1). Schedule adds a row to the Interviews board for either source. */}
          <button className="secondary" onClick={(e) => { e.stopPropagation(); onPdf(); }}>📄 PDF</button>
          {remote
            ? (row.job_link && <a className="secondary" href={row.job_link} target="_blank" rel="noreferrer"
                style={{ marginLeft: 4, textDecoration: 'none', display: 'inline-block' }}
                onClick={(e) => e.stopPropagation()} title="Open the job posting">↗ Job</a>)
            : <button className="secondary" style={{ marginLeft: 4 }} onClick={(e) => { e.stopPropagation(); onJump(); }} title="Find this job in the Jobs tab">↗ Job</button>}
          <button className="secondary" style={{ marginLeft: 4 }} disabled={scheduling}
            onClick={async (e) => { e.stopPropagation(); setScheduling(true); try { await onSchedule(); } finally { setScheduling(false); } }}
            title="Add this resume + job description as a row on the Interviews board">{scheduling ? '…' : '📅 Schedule'}</button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ background: 'var(--panel-2)', padding: '1rem' }}>
            {isLoading ? <span className="spinner" /> : detail ? (
              <div style={{ fontSize: '0.86rem', lineHeight: 1.6 }}>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
                  <span><strong>Region:</strong> {detail.region || '—'}</span>
                  <span><strong>Job status:</strong> {detail.job_exists ? (detail.status || '—') : 'deleted'}</span>
                  {detail.link && <a href={detail.link} target="_blank" rel="noreferrer">Open posting ↗</a>}
                </div>
                <div style={{ fontWeight: 700, fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                  Job description
                </div>
                <div style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                  {detail.description || '(no description stored)'}
                </div>
              </div>
            ) : <span className="muted">Failed to load job detail.</span>}
          </td>
        </tr>
      )}
    </>
  );
}
