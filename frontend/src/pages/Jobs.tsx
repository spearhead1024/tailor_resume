import React, { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient, useMutation, keepPreviousData } from '@tanstack/react-query';
import { useUrlState, useOnChange } from '../lib/urlState';
import { api } from '../api/client';
import { useAuth, hasRole } from '../lib/auth';
import { useToast } from '../lib/toast';
import { etDateLong, etDateShort, etDateKey, todayETKey } from '../lib/etTime';
import CompanyBadge from '../lib/CompanyBadge';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const BLANK_JOB = { company: '', job_title: '', description: '', link: '', region: 'US', note: '' };
// The add-job form starts on the region last used, so adding a batch of EU jobs
// doesn't mean re-picking EU every time (a personal default → localStorage, not URL).
const LAST_REGION_KEY = 'jobs.lastRegion';
// The markets jobs and profiles are matched on (the server rejects anything else).
const JOB_REGIONS: [string, string][] = [['US', 'US'], ['EU', 'EU'], ['LATAM', 'LATAM'], ['ANY', 'Any']];
const normRegion = (r: string) => { const v = String(r || '').toUpperCase(); const x = v === 'GLOBAL' ? 'ANY' : v; return JOB_REGIONS.some(([k]) => k === x) ? x : 'US'; };
const RegionOptions = () => <>{JOB_REGIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</>;
const lastRegion = () => { try { return normRegion(localStorage.getItem(LAST_REGION_KEY) || 'US'); } catch { return 'US'; } };
// The server's submit rules (routers/jobs.py _clean_job_fields), checked as the form is filled
// so Save is only offered for a job the server will accept.
const MIN_DESCRIPTION = 100;
function jobProblems(j: { company: string; job_title: string; link: string; description: string }): string[] {
  const out: string[] = [];
  const missing = ([['company', 'company'], ['job_title', 'job title'], ['link', 'job link'], ['description', 'description']] as const)
    .filter(([k]) => !String(j[k] || '').trim()).map(([, l]) => l);
  if (missing.length) out.push(`Still needed: ${missing.join(', ')}`);
  const link = String(j.link || '').trim();
  if (link) {
    let good = false;
    try { const u = new URL(link); good = /^https?:$/.test(u.protocol) && u.hostname.includes('.') && !/\s/.test(link); } catch { /* not a URL */ }
    if (!good) out.push('The link must be a full web address (https://…)');
  }
  for (const [k, l] of [['company', 'company'], ['job_title', 'job title']] as const) {
    if (/^(https?:\/\/|www\.)/i.test(String(j[k] || '').trim())) out.push(`The ${l} looks like a link`);
  }
  const desc = String(j.description || '').trim();
  if (desc && desc.length < MIN_DESCRIPTION) out.push(`The description is too short (${desc.length}/${MIN_DESCRIPTION} characters)`);
  return out;
}
const REQ = <span style={{ color: 'var(--danger, #dc2626)' }} title="Required"> *</span>;
const rememberRegion = (r: string) => { try { localStorage.setItem(LAST_REGION_KEY, r); } catch { /* storage blocked */ } };
const blankJob = () => ({ ...BLANK_JOB, region: lastRegion() });

function formatJobError(err: any, fallback: string): string {
  const d = err?.response?.data?.detail;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && d.message) return d.message;
  return err?.message || fallback;
}

function formatDay(iso: string): string { return etDateLong(iso, 'Unknown date'); }
function formatDate(iso: string): string { return etDateShort(iso, '—'); }

// Status dropdown and Edit button share one size so the row's actions line up.
const JOB_ACTION_CTRL: React.CSSProperties = {
  height: 32, boxSizing: 'border-box', padding: '0 0.6rem', fontSize: '0.85rem', lineHeight: 1,
  width: 120, margin: 0,
};

type DupConflict = { kind: string; message: string; existing_id?: string; existing_company?: string; existing_title?: string };

/** Live duplicate check while a job is being typed: the same rules the server
 *  applies on save (same link, same company + title, one per company/region/month,
 *  blacklist), run ~0.5s after the user stops typing — so a duplicate is caught
 *  before they fill in the description and click Save. */
function useDuplicateCheck(fields: { company: string; job_title: string; link: string; region: string }, excludeId = '') {
  const [state, setState] = useState<{ checking: boolean; conflicts: DupConflict[] }>({ checking: false, conflicts: [] });
  const seq = React.useRef(0);
  const { company, job_title, link, region } = fields;
  useEffect(() => {
    if (!company.trim() && !link.trim()) { setState({ checking: false, conflicts: [] }); return; }
    const my = ++seq.current;
    setState((s) => ({ ...s, checking: true }));
    const t = window.setTimeout(async () => {
      try {
        const r = await api.post<{ duplicate: boolean; conflicts: DupConflict[] }>('/api/jobs/check-duplicate',
          { company, job_title, link, region, exclude_job_id: excludeId });
        if (my === seq.current) setState({ checking: false, conflicts: r.conflicts || [] });
      } catch {
        if (my === seq.current) setState({ checking: false, conflicts: [] });   // never block on a failed check
      }
    }, 500);
    return () => window.clearTimeout(t);
  }, [company, job_title, link, region, excludeId]);
  return state;
}

function DuplicateNotice({ checking, conflicts }: { checking: boolean; conflicts: DupConflict[] }) {
  if (checking && !conflicts.length) return <div className="muted" style={{ fontSize: '0.82rem', margin: '-4px 0 10px' }}>Checking for duplicates…</div>;
  if (!conflicts.length) return null;
  return (
    <div style={{ margin: '-4px 0 12px', padding: '0.55rem 0.75rem', borderRadius: 8, fontSize: '0.85rem',
      background: 'rgba(220,38,38,0.10)', border: '1px solid rgba(220,38,38,0.45)', color: 'var(--st-danger-fg, var(--danger))' }}>
      <strong>Can't save — duplicate:</strong>
      <ul style={{ margin: '4px 0 0', paddingLeft: '1.1rem' }}>
        {conflicts.map((c, i) => <li key={i}>{c.message}</li>)}
      </ul>
    </div>
  );
}

interface JobsResponse {
  jobs: any[];
  total: number;
  page: number;
  page_size: number;
  counts: Record<string, number>;
}

// Compact filter-bar controls: the global input/select rule is width:100%, which is what stretched
// the old bar over two lines. Every control here has its own width and never grows.
// One size for every control — inputs, selects, date pickers and buttons alike: the same height,
// font size and weight, with the padding set so the content box can't push the height around.
const CTRL_H = 34;
const FILTER: CSSProperties = {
  flex: '0 0 auto', height: CTRL_H, boxSizing: 'border-box', padding: '0 0.6rem',
  fontSize: '0.84rem', fontWeight: 400, lineHeight: 'normal',
};
const FILTER_BTN: CSSProperties = { ...FILTER, padding: '0 0.75rem', fontWeight: 500, whiteSpace: 'nowrap', justifyContent: 'center' };
const FILTER_LABEL: CSSProperties = {
  flex: '0 0 auto', fontSize: '0.84rem', color: 'var(--muted)', whiteSpace: 'nowrap',
  textTransform: 'none', letterSpacing: 0, fontWeight: 400, margin: 0,
};

// ?added_by= value for "no adder on record" — must match storage.ADDED_BY_NONE on the server.
const ADDED_BY_NONE = '__none__';

export default function Jobs() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = !!user?.is_admin;
  // Admins and job_adders both review/dismiss reported jobs.
  const canReview = hasRole(user, 'admin', 'job_adder');

  // Filters (server-side) live in the URL (lib/urlState) — they survive a refresh,
  // and a link like /jobs?company=Acme&status=&from=&to= opens one company across all dates.
  const [query, setQuery] = useUrlState('q', '');
  const [debouncedQuery, setDebouncedQuery] = useState(query.trim());
  const [statusFilter, setStatusFilter] = useUrlState('status', 'approved');
  const [regionFilter, setRegionFilter] = useUrlState('region', '');
  const [companyFilter, setCompanyFilter] = useUrlState('company', '');
  // Admin-only: one adder's jobs (the "Added by" column). ADDED_BY_NONE = jobs with no adder on record.
  const [addedByFilter, setAddedByFilter] = useUrlState('added_by', '');
  // Default to today (ET) so the Jobs tab opens on today's intake.
  const [dateFrom, setDateFrom] = useUrlState('from', todayETKey());
  const [dateTo, setDateTo] = useUrlState('to', todayETKey());
  const [reportedOnly, setReportedOnly] = useUrlState('reported', false);
  const [page, setPage] = useUrlState('page', 1);
  const [pageSize, setPageSize] = useUrlState('size', 20);

  // Form / edit state
  const [showForm, setShowForm] = useState(false);
  const [newJob, setNewJob] = useState(blankJob);
  const newDup = useDuplicateCheck(showForm ? newJob : BLANK_JOB);
  const newProblems = jobProblems(newJob);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<any>({});
  const editDup = useDuplicateCheck(
    editingId ? { company: editDraft.company || '', job_title: editDraft.job_title || '', link: editDraft.link || '', region: editDraft.region || '' } : BLANK_JOB,
    editingId || '');
  const editProblems = editingId ? jobProblems({ company: editDraft.company || '', job_title: editDraft.job_title || '', link: editDraft.link || '', description: editDraft.description || '' }) : [];

  // Debounce the free-text search so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  // Back to page 1 whenever a filter changes (not on load — the URL's page stands).
  useOnChange([debouncedQuery, statusFilter, regionFilter, companyFilter, addedByFilter, dateFrom, dateTo, reportedOnly, pageSize], () => setPage(1));

  // Every filter EXCEPT Added by — also what the "Added by" counts are computed within, so each
  // option's count is exactly what picking it would list.
  const filterParams = useMemo(() => {
    const sp = new URLSearchParams();
    // In reported-review mode, ignore the status filter so flagged jobs of any
    // status surface together.
    if (statusFilter && !reportedOnly) sp.set('status', statusFilter);
    if (regionFilter) sp.set('region', regionFilter);
    if (companyFilter.trim()) sp.set('company', companyFilter.trim());
    if (debouncedQuery) sp.set('q', debouncedQuery);
    if (dateFrom) sp.set('date_from', dateFrom);
    if (dateTo) sp.set('date_to', dateTo);
    if (reportedOnly) sp.set('reported', 'true');
    return sp.toString();
  }, [statusFilter, regionFilter, companyFilter, debouncedQuery, dateFrom, dateTo, reportedOnly]);
  const params = useMemo(() => {
    const sp = new URLSearchParams(filterParams);
    if (isAdmin && addedByFilter) sp.set('added_by', addedByFilter);
    sp.set('page', String(page));
    sp.set('page_size', String(pageSize));
    return sp.toString();
  }, [filterParams, addedByFilter, isAdmin, page, pageSize]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['jobs', params],
    queryFn: () => api.get<JobsResponse>(`/api/jobs?${params}`),
    placeholderData: keepPreviousData,
    // While any visible company is still being checked (a just-added job), poll so
    // its startup/size badge fills in on its own; stop once all are resolved.
    refetchInterval: (q) => (q.state.data?.jobs || []).some((j: any) => j.company_info?.status === 'pending') ? 5000 : false,
  });

  // Options for the "Added by" filter — adders with jobs in the current filters (period, status,
  // region, search…), each with that count. Kept while the next one loads so the list doesn't blink.
  const { data: adders = [] } = useQuery({
    queryKey: ['jobs', 'adders', filterParams],
    queryFn: () => api.get<{ name: string; count: number }[]>(`/api/jobs/adders?${filterParams}`),
    enabled: isAdmin,
    placeholderData: keepPreviousData,
  });

  const jobs = data?.jobs || [];
  const total = data?.total || 0;
  const counts = data?.counts || { approved: 0, pending: 0, rejected: 0, deleted: 0, total: 0 };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  // Deleting/rejecting everything on the last page left page > totalPages: an empty list labelled
  // "Page N-1 of N-1" with Next disabled. Snap back to the real last page once the counts arrive.
  useEffect(() => { if (data && page > totalPages) setPage(totalPages); }, [data, page, totalPages, setPage]);

  const createMutation = useMutation({
    mutationFn: (payload: any) => api.post('/api/jobs', { payload }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['jobs'] }); setPage(1); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) => api.patch(`/api/jobs/${id}`, { payload }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['jobs'] }); setEditingId(null); },
    onError: (e: any) => toast(formatJobError(e, 'Failed to update job'), 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/jobs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
    onError: (e: any) => toast(formatJobError(e, 'Failed to delete job'), 'error'),
  });

  const clearReportMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/jobs/${id}/reports/clear`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['jobs'] }); toast('Reports dismissed — job back in circulation', 'success'); },
    onError: (e: any) => toast(formatJobError(e, 'Failed to dismiss reports'), 'error'),
  });

  const syncMutation = useMutation({
    mutationFn: () => api.post<any>('/api/jobs/sync-now'),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      const ins = res?.inserted ?? 0;
      const blk = res?.blocked ?? 0;
      toast(`Sync done — ${ins} new, ${res?.skipped ?? 0} skipped, ${blk} blocked`, 'success');
    },
    onError: (e: any) => toast(formatJobError(e, 'Sync failed'), 'error'),
  });

  // ── Bulk selection (admin) ──────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Selection is per-page: clear it whenever the query (page/filters) changes.
  useEffect(() => { setSelected(new Set()); }, [params]);

  const pageIds: string[] = jobs.map((j: any) => j.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someSelected = pageIds.some((id) => selected.has(id));
  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allSelected) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    return next;
  });
  const toggleOne = (id: string) => setSelected((prev) => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  async function runBulk(label: string, fn: (id: string) => Promise<any>) {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(ids.map(fn));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = ids.length - ok;
    setBulkBusy(false);
    qc.invalidateQueries({ queryKey: ['jobs'] });
    setSelected(new Set());
    toast(`${label}: ${ok} done${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
  }
  const bulkApprove = () => runBulk('Approved', (id) => api.patch(`/api/jobs/${id}`, { payload: { status: 'approved' } }));
  const bulkReject = () => runBulk('Rejected', (id) => api.patch(`/api/jobs/${id}`, { payload: { status: 'rejected' } }));
  // Copy the job links of the selected jobs, one per line, in the order shown on the page.
  const copyLinks = async () => {
    const links = jobs.filter((j: any) => selected.has(j.id)).map((j: any) => String(j.link || '').trim()).filter(Boolean);
    const missing = selected.size - links.length;
    if (!links.length) { toast('None of the selected jobs has a link', 'error'); return; }
    try {
      await navigator.clipboard.writeText(links.join('\n'));
      toast(`Copied ${links.length} link${links.length === 1 ? '' : 's'}${missing ? ` (${missing} without a link skipped)` : ''}`, 'success');
    } catch {
      toast('Could not copy — the browser blocked clipboard access', 'error');
    }
  };
  const bulkDelete = () => { if (!confirm(`Delete ${selected.size} selected job(s)?`)) return; runBulk('Deleted', (id) => api.delete(`/api/jobs/${id}`)); };

  // Group the current page by the day each job was added (ET).
  const groups = useMemo(() => {
    const keyOf = (job: any): { key: string; label: string } => {
      const ts = job.submitted_at || job.approved_at || '';
      return { key: etDateKey(ts), label: formatDay(ts) };
    };
    const out: { key: string; label: string; jobs: any[] }[] = [];
    for (const job of jobs) {
      const { key, label } = keyOf(job);
      const last = out[out.length - 1];
      if (last && last.key === key) last.jobs.push(job);
      else out.push({ key, label, jobs: [job] });
    }
    return out;
  }, [jobs]);

  async function handleCreate(keepOpen = false) {
    // Manually-added jobs (by admins or job_adders) go live as approved.
    const status = 'approved';
    const label = newJob.company || 'job';
    try {
      await createMutation.mutateAsync({ ...newJob, status });
      setNewJob(blankJob());
      if (keepOpen) toast(`Saved "${label}" — ready for the next one`, 'success');
      else { setShowForm(false); toast(`Saved "${label}"`, 'success'); }
    } catch (e: any) {
      toast(formatJobError(e, 'Failed to save job'), 'error');
    }
  }

  async function startEdit(job: any) {
    setEditingId(job.id);
    // The list payload omits description/note — fetch the full row to edit.
    try {
      const full = await api.get<any>(`/api/jobs/${job.id}`);
      setEditDraft({
        company: full.company || '', job_title: full.job_title || '',
        link: full.link || '', region: normRegion(full.region),
        description: full.description || '', note: full.note || '',
      });
    } catch {
      setEditDraft({
        company: job.company || '', job_title: job.job_title || '',
        link: job.link || '', region: normRegion(job.region), description: '', note: '',
      });
    }
  }

  function goPage(n: number) { setPage(Math.max(1, Math.min(n, totalPages))); setEditingId(null); }

  // "Today" resets dates to today (the default view); "all dates" clears them.
  function resetToToday() {
    setQuery(''); setRegionFilter(''); setCompanyFilter(''); setAddedByFilter('');
    setDateFrom(todayETKey()); setDateTo(todayETKey());
  }
  function showAllDates() { setDateFrom(''); setDateTo(''); }

  const today = todayETKey();
  const isTodayOnly = dateFrom === today && dateTo === today;
  const hasExtraFilters = !!(regionFilter || companyFilter || addedByFilter || query || !isTodayOnly);

  return (
    <div>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Jobs</h1>
        {isFetching && <span className="spinner" />}
        <div style={{ flex: 1 }} />
        <button
          className="secondary"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending || !isAdmin}
          title={isAdmin ? 'Fetch new jobs from the remote server now' : 'Only an admin can fetch new jobs'}>
          {syncMutation.isPending ? <span className="spinner" /> : '⟳ Fetch new jobs'}
        </button>
        <button onClick={() => { setShowForm(!showForm); setNewJob(blankJob()); }}>
          {showForm ? 'Cancel' : '+ New Job'}
        </button>
      </div>

      {/* Filter bar — ONE line on a desktop screen: every control is compact and fixed-width, only
          the search box flexes. On a screen too narrow to fit it the line scrolls sideways rather
          than wrapping, so the controls never reflow under each other. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: '0.75rem', alignItems: 'center', flexWrap: 'nowrap', overflowX: 'auto', paddingBottom: 2 }}>
        <input placeholder="Search company or title…" value={query}
          onChange={(e) => setQuery(e.target.value)} style={{ ...FILTER, flex: '1 1 170px', minWidth: 120, maxWidth: 260 }} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...FILTER, width: 110 }} title="Status">
          <option value="">All statuses</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
          <option value="rejected">Rejected</option>
          <option value="deleted">Deleted</option>
        </select>
        <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} style={{ ...FILTER, width: 100 }} title="Region">
          <option value="">All regions</option>
          <RegionOptions />
        </select>
        {isAdmin && <label htmlFor="jobs-added-by" style={FILTER_LABEL}>Added by</label>}
        {isAdmin && (
          <select id="jobs-added-by" value={addedByFilter} onChange={(e) => setAddedByFilter(e.target.value)}
            style={{ ...FILTER, width: 124 }} title="Show only the jobs one person added">
            <option value="">All</option>
            {/* The person picked may have no jobs under the other filters (or be a deleted account
                named in a link) — keep them shown as the selection, not blank. */}
            {addedByFilter && addedByFilter !== ADDED_BY_NONE
              && !adders.some((a) => a.name.toLowerCase() === addedByFilter.toLowerCase())
              && <option value={addedByFilter}>{addedByFilter} (0)</option>}
            {adders.filter((a) => a.name).map((a) => (
              <option key={a.name} value={a.name}>{a.name} ({a.count})</option>
            ))}
            {adders.some((a) => !a.name) && (
              <option value={ADDED_BY_NONE}>— Unknown ({adders.find((a) => !a.name)?.count}) —</option>
            )}
          </select>
        )}
        {/* There is no Company box any more (Search covers it), but a link can still open one company
            (the Screenshots tab's "Job" button does) — show that filter so it can be seen and removed. */}
        {companyFilter && (
          <span style={{ ...FILTER, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', maxWidth: 200,
            border: '1px solid var(--border-soft)', borderRadius: 999, background: 'var(--panel-2)', color: 'var(--text-soft)' }}
            title={`Company: ${companyFilter}`}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Company: {companyFilter}</span>
            <button className="ghost" onClick={() => setCompanyFilter('')} title="Remove the company filter"
              style={{ padding: '0 4px', border: 0, fontSize: '0.8rem' }}>✕</button>
          </span>
        )}
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ ...FILTER, width: 130 }}
          title="Added from (ET date)" aria-label="Added from" />
        <span style={FILTER_LABEL}>–</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ ...FILTER, width: 130 }}
          title="Added to (ET date)" aria-label="Added to" />
        <button className={isTodayOnly ? '' : 'secondary'} onClick={resetToToday}
          style={FILTER_BTN} title="Show only today's jobs (ET)">Today</button>
        {(dateFrom || dateTo) && (
          <button className="secondary" onClick={showAllDates} style={FILTER_BTN} title="Remove the date filter">All dates</button>
        )}
        {hasExtraFilters && (
          <button className="secondary" onClick={resetToToday} style={FILTER_BTN} title="Reset every filter to today's jobs">Clear</button>
        )}
        <label style={{
          ...FILTER_LABEL, display: 'inline-flex', alignItems: 'center', gap: 6, height: CTRL_H,
          marginLeft: 'auto', cursor: 'pointer',
          color: reportedOnly ? 'var(--danger, #dc2626)' : 'var(--text)', fontWeight: reportedOnly ? 600 : 400,
        }}>
          <input type="checkbox" checked={reportedOnly} onChange={(e) => setReportedOnly(e.target.checked)} />
          <span title="Show only jobs someone reported">⚑ Reported</span>
        </label>
      </div>

      {/* Status counts */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap', fontSize: '0.88rem' }}>
        {(['approved', 'pending', 'rejected', 'deleted'] as const).map((s) => (
          <span key={s} style={{ cursor: 'pointer' }} onClick={() => setStatusFilter(s)}>
            <span className={`pill ${s}`}>{s}</span>
            <strong style={{ marginLeft: 4 }}>{counts[s] ?? 0}</strong>
          </span>
        ))}
        <span className="muted">/ {counts.total ?? 0} match{(counts.total ?? 0) === 1 ? '' : 'es'} filters</span>
      </div>

      {/* Add job form */}
      {showForm && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>Add job</h2>
          <div className="row">
            <div className="field"><label>Company{REQ}</label><input value={newJob.company} onChange={(e) => setNewJob({ ...newJob, company: e.target.value })} /></div>
            <div className="field"><label>Job title{REQ}</label><input value={newJob.job_title} onChange={(e) => setNewJob({ ...newJob, job_title: e.target.value })} /></div>
          </div>
          <div className="row">
            <div className="field"><label>Link{REQ}</label><input value={newJob.link} placeholder="https://…" onChange={(e) => setNewJob({ ...newJob, link: e.target.value })} /></div>
            <div className="field"><label>Region</label>
              <select value={newJob.region} onChange={(e) => { rememberRegion(e.target.value); setNewJob({ ...newJob, region: e.target.value }); }}>
                <RegionOptions />
              </select>
            </div>
          </div>
          <DuplicateNotice checking={newDup.checking} conflicts={newDup.conflicts} />
          <div className="field"><label>Description{REQ}</label><textarea rows={8} value={newJob.description} placeholder="The full job posting" onChange={(e) => setNewJob({ ...newJob, description: e.target.value })} /></div>
          <div className="field">
            <label>Application questions (one per line)</label>
            <textarea rows={4} value={newJob.note} onChange={(e) => setNewJob({ ...newJob, note: e.target.value })}
              placeholder={'Why are you a strong fit for this role?\nTell us about your most relevant experience.\nWhy do you want to work here?'} />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => handleCreate(false)} disabled={newProblems.length > 0 || createMutation.isPending || newDup.conflicts.length > 0}
              title={newProblems.join(' · ') || undefined}>
              {createMutation.isPending ? <span className="spinner" /> : 'Save'}
            </button>
            <button className="secondary" onClick={() => handleCreate(true)}
              disabled={newProblems.length > 0 || createMutation.isPending || newDup.conflicts.length > 0}
              title={newProblems.join(' · ') || 'Save this job and keep the form open for the next one'}>
              {createMutation.isPending ? <span className="spinner" /> : 'Save & Add Another'}
            </button>
            {newProblems.length > 0 && <span className="muted" style={{ fontSize: '0.85rem' }}>{newProblems.join(' · ')}</span>}
          </div>
        </div>
      )}

      {/* Pagination — top */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {totalPages > 1 && (
          <>
            <button className="secondary" disabled={safePage === 1} onClick={() => goPage(safePage - 1)}>← Prev</button>
            <span className="muted" style={{ fontSize: '0.9rem' }}>Page {safePage} of {totalPages}</span>
            <button className="secondary" disabled={safePage === totalPages} onClick={() => goPage(safePage + 1)}>Next →</button>
          </>
        )}
        <span className="muted" style={{ fontSize: '0.85rem', marginLeft: totalPages > 1 ? 8 : 0 }}>
          {total} job{total === 1 ? '' : 's'} total
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="muted" style={{ fontSize: '0.8rem' }}>Rows</span>
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
            style={{ width: 'auto', padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}>
            {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {/* Jobs table with group separator rows */}
      {isLoading ? (
        <div><span className="spinner" /> Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="card"><span className="muted">No jobs match the current filters.</span></div>
      ) : (
        <>
        {isAdmin && selected.size > 0 && (
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.5rem 0.8rem', marginBottom: 8 }}>
            <strong>{selected.size} selected</strong>
            <button className="secondary" onClick={bulkApprove} disabled={bulkBusy}>Approve</button>
            <button className="secondary" onClick={bulkReject} disabled={bulkBusy}>Reject</button>
            <button className="secondary" onClick={copyLinks} disabled={bulkBusy} title="Copy the job links of the selected jobs, one per line">⧉ Copy links</button>
            <button className="danger" onClick={bulkDelete} disabled={bulkBusy}>Delete</button>
            <button className="ghost" style={{ marginLeft: 'auto' }} onClick={() => setSelected(new Set())} disabled={bulkBusy}>Clear</button>
            {bulkBusy && <span className="spinner" />}
          </div>
        )}
        <table>
          <thead>
            <tr>
              {isAdmin && (
                <th style={{ width: 28 }}>
                  <input type="checkbox" checked={allSelected} title="Select all on this page"
                    ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    onChange={toggleAll} />
                </th>
              )}
              <th>Company</th><th style={{ width: '22%' }}>Job title</th><th>Region</th><th>Status</th>
              <th style={{ whiteSpace: 'nowrap' }}>AddedAt</th>
              {isAdmin && <th style={{ whiteSpace: 'nowrap' }}>Added by</th>}
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <React.Fragment key={group.key}>
                <tr>
                  <td colSpan={isAdmin ? 8 : 5} style={{
                    padding: '0.5rem 0.75rem', fontWeight: 600, fontSize: '0.85rem',
                    color: 'var(--muted)', background: 'var(--panel-2)', borderTop: '2px solid var(--border)',
                  }}>
                    {group.label} — {group.jobs.length} {group.jobs.length === 1 ? 'job' : 'jobs'}
                  </td>
                </tr>
                {group.jobs.map((job) => (
                  <React.Fragment key={job.id}>
                    <tr style={job.flagged ? { background: 'rgba(220,38,38,0.06)' } : undefined}>
                      {isAdmin && (
                        <td style={{ width: 28 }}>
                          <input type="checkbox" checked={selected.has(job.id)} onChange={() => toggleOne(job.id)} />
                        </td>
                      )}
                      <td>
                        {job.flagged && (
                          <span title={`Reported ${job.reports_count}×`} style={{ color: 'var(--danger,#dc2626)', marginRight: 5 }}>⚑</span>
                        )}
                        {job.company}
                        <div style={{ marginTop: 2 }}>
                          <CompanyBadge info={job.company_info} isAdmin={isAdmin} compact
                            onChanged={() => qc.invalidateQueries({ queryKey: ['jobs'] })} />
                        </div>
                      </td>
                      <td style={{ maxWidth: 260, overflowWrap: 'anywhere' }}>{job.link ? <a href={job.link} target="_blank" rel="noreferrer">{job.job_title}</a> : job.job_title}</td>
                      <td>{job.region}</td>
                      <td><span className={`pill ${job.status}`}>{job.status}</span></td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>{formatDate(job.submitted_at || job.approved_at)}</td>
                      {isAdmin && (
                        <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                          {job.created_by_username || <span className="muted">—</span>}
                        </td>
                      )}
                      {isAdmin && (
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <select value={job.status} disabled={updateMutation.isPending}
                              onChange={(e) => {
                                const next = e.target.value;
                                if (next === 'deleted' && !confirm(`Mark "${job.company} — ${job.job_title}" as deleted? It will be permanently hidden and never re-synced.`)) return;
                                updateMutation.mutate({ id: job.id, payload: { status: next } });
                              }}
                              style={JOB_ACTION_CTRL}>
                              <option value="approved">approved</option>
                              <option value="pending">pending</option>
                              <option value="rejected">rejected</option>
                              <option value="deleted">deleted</option>
                            </select>
                            <button className="secondary" style={{ ...JOB_ACTION_CTRL, width: 76 }}
                              onClick={() => editingId === job.id ? setEditingId(null) : startEdit(job)}>
                              {editingId === job.id ? 'Cancel' : 'Edit'}
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                    {job.flagged && (job.reports?.length || 0) > 0 && (
                      <tr>
                        <td colSpan={isAdmin ? 8 : 5} style={{ padding: '0.75rem 1rem', background: 'rgba(220,38,38,0.06)', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 12 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--danger,#dc2626)', marginBottom: 4 }}>
                                ⚑ Reported {job.reports_count}× — pending review
                              </div>
                              {(job.reports || []).map((r: any, i: number) => (
                                <div key={i} style={{ fontSize: '0.83rem', marginBottom: 2 }}>
                                  “{r.reason}”
                                  <span className="muted" style={{ marginLeft: 6, fontSize: '0.78rem' }}>
                                    — {r.reported_by_username || 'unknown'}{r.reported_at ? ` · ${etDateShort(r.reported_at)}` : ''}
                                  </span>
                                </div>
                              ))}
                            </div>
                            {canReview && (
                              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                                <button className="secondary"
                                  disabled={clearReportMutation.isPending}
                                  title="Dismiss reports — job returns to Resumes/Apply"
                                  onClick={() => clearReportMutation.mutate(job.id)}>
                                  ✓ Dismiss reports
                                </button>
                                <button className="danger"
                                  disabled={updateMutation.isPending}
                                  title="Reject the job — keeps it out of circulation"
                                  onClick={() => updateMutation.mutate({ id: job.id, payload: { status: 'rejected' } })}>
                                  Reject job
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    {editingId === job.id && (
                      <tr>
                        <td colSpan={isAdmin ? 8 : 5} style={{ padding: '1rem', background: 'var(--panel-2)' }}>
                          <div className="row">
                            <div className="field"><label>Company{REQ}</label><input value={editDraft.company} onChange={(e) => setEditDraft({ ...editDraft, company: e.target.value })} /></div>
                            <div className="field"><label>Job title{REQ}</label><input value={editDraft.job_title} onChange={(e) => setEditDraft({ ...editDraft, job_title: e.target.value })} /></div>
                          </div>
                          <div className="row">
                            <div className="field"><label>Link{REQ}</label><input value={editDraft.link} onChange={(e) => setEditDraft({ ...editDraft, link: e.target.value })} /></div>
                            <div className="field"><label>Region</label>
                              <select value={editDraft.region} onChange={(e) => setEditDraft({ ...editDraft, region: e.target.value })}>
                                <RegionOptions />
                              </select>
                            </div>
                          </div>
                          <DuplicateNotice checking={editDup.checking} conflicts={editDup.conflicts} />
                          <div className="field"><label>Description{REQ}</label><textarea rows={6} value={editDraft.description} onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })} /></div>
                          <div className="field">
                            <label>Application questions (one per line)</label>
                            <textarea rows={4} value={editDraft.note} onChange={(e) => setEditDraft({ ...editDraft, note: e.target.value })} />
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => updateMutation.mutate({ id: job.id, payload: editDraft })} disabled={editProblems.length > 0 || updateMutation.isPending || editDup.conflicts.length > 0}
                              title={editProblems.join(' · ') || undefined}>
                              {updateMutation.isPending ? <span className="spinner" /> : 'Save changes'}
                            </button>
                            <button className="secondary" onClick={() => setEditingId(null)}>Cancel</button>
                            {editProblems.length > 0 && <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>{editProblems.join(' · ')}</span>}
                            <div style={{ flex: 1 }} />
                            <button className="danger" onClick={() => { if (confirm('Delete this job?')) deleteMutation.mutate(job.id); }}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        </>
      )}

      {/* Pagination — bottom */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: '1rem' }}>
          <button className="secondary" disabled={safePage === 1} onClick={() => goPage(safePage - 1)}>← Prev</button>
          <span className="muted" style={{ fontSize: '0.9rem' }}>Page {safePage} of {totalPages}</span>
          <button className="secondary" disabled={safePage === totalPages} onClick={() => goPage(safePage + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}
