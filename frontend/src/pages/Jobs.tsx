import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation, keepPreviousData } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth, hasRole } from '../lib/auth';
import { useToast } from '../lib/toast';
import { etDateLong, etDateShort, etDateKey, todayETKey } from '../lib/etTime';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const BLANK_JOB = { company: '', job_title: '', description: '', link: '', region: 'US', note: '' };
type GroupBy = 'day' | 'region' | 'status' | 'company';

function formatJobError(err: any, fallback: string): string {
  const d = err?.response?.data?.detail;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && d.message) return d.message;
  return err?.message || fallback;
}

function formatDay(iso: string): string { return etDateLong(iso, 'Unknown date'); }
function formatDate(iso: string): string { return etDateShort(iso, '—'); }

interface JobsResponse {
  jobs: any[];
  total: number;
  page: number;
  page_size: number;
  counts: Record<string, number>;
}

export default function Jobs() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = !!user?.is_admin;
  // Admins and job_adders both review/dismiss reported jobs.
  const canReview = hasRole(user, 'admin', 'job_adder');

  // Deep-link from the Applied tab: ?company=… opens this job across all dates.
  const [searchParams, setSearchParams] = useSearchParams();
  const jumpCompany = searchParams.get('company') || '';

  // Filters (server-side)
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(jumpCompany ? '' : 'approved');
  const [regionFilter, setRegionFilter] = useState('');
  const [companyFilter, setCompanyFilter] = useState(jumpCompany);
  // Default to today (ET) so the Jobs tab opens on today's intake — unless we
  // arrived via a company deep-link, in which case show all dates.
  const [dateFrom, setDateFrom] = useState(jumpCompany ? '' : todayETKey());
  const [dateTo, setDateTo] = useState(jumpCompany ? '' : todayETKey());
  const [reportedOnly, setReportedOnly] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // Form / edit state
  const [showForm, setShowForm] = useState(false);
  const [newJob, setNewJob] = useState({ ...BLANK_JOB });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<any>({});

  // Consume the ?company= deep-link param once, then strip it from the URL so
  // it doesn't stick on later navigation.
  useEffect(() => {
    if (jumpCompany) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce the free-text search so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setPage(1); }, [debouncedQuery, statusFilter, regionFilter, companyFilter, dateFrom, dateTo, reportedOnly, pageSize]);

  const params = useMemo(() => {
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
    sp.set('page', String(page));
    sp.set('page_size', String(pageSize));
    return sp.toString();
  }, [statusFilter, regionFilter, companyFilter, debouncedQuery, dateFrom, dateTo, reportedOnly, page, pageSize]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['jobs', params],
    queryFn: () => api.get<JobsResponse>(`/api/jobs?${params}`),
    placeholderData: keepPreviousData,
  });

  const jobs = data?.jobs || [];
  const total = data?.total || 0;
  const counts = data?.counts || { approved: 0, pending: 0, rejected: 0, deleted: 0, total: 0 };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

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
  const bulkDelete = () => { if (!confirm(`Delete ${selected.size} selected job(s)?`)) return; runBulk('Deleted', (id) => api.delete(`/api/jobs/${id}`)); };

  // Group the current page by the selected dimension.
  const groups = useMemo(() => {
    const keyOf = (job: any): { key: string; label: string } => {
      if (groupBy === 'region') return { key: job.region || '—', label: `Region: ${job.region || '—'}` };
      if (groupBy === 'status') return { key: job.status || '—', label: `Status: ${job.status || '—'}` };
      if (groupBy === 'company') return { key: job.company || '—', label: job.company || '—' };
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
  }, [jobs, groupBy]);

  async function handleCreate(keepOpen = false) {
    // Manually-added jobs (by admins or job_adders) go live as approved.
    const status = 'approved';
    const label = newJob.company || 'job';
    try {
      await createMutation.mutateAsync({ ...newJob, status });
      setNewJob({ ...BLANK_JOB });
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
        link: full.link || '', region: full.region || 'US',
        description: full.description || '', note: full.note || '',
      });
    } catch {
      setEditDraft({
        company: job.company || '', job_title: job.job_title || '',
        link: job.link || '', region: job.region || 'US', description: '', note: '',
      });
    }
  }

  function goPage(n: number) { setPage(Math.max(1, Math.min(n, totalPages))); setEditingId(null); }

  // "Today" resets dates to today (the default view); "all dates" clears them.
  function resetToToday() {
    setQuery(''); setRegionFilter(''); setCompanyFilter('');
    setDateFrom(todayETKey()); setDateTo(todayETKey());
  }
  function showAllDates() { setDateFrom(''); setDateTo(''); }

  const today = todayETKey();
  const isTodayOnly = dateFrom === today && dateTo === today;
  const hasExtraFilters = !!(regionFilter || companyFilter || query || !isTodayOnly);

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
        <button onClick={() => { setShowForm(!showForm); setNewJob({ ...BLANK_JOB }); }}>
          {showForm ? 'Cancel' : '+ New Job'}
        </button>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Search company or title…" value={query}
          onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 220 }} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ maxWidth: 150 }}>
          <option value="">All statuses</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
          <option value="rejected">Rejected</option>
          <option value="deleted">Deleted</option>
        </select>
        <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} style={{ maxWidth: 120 }}>
          <option value="">All regions</option>
          <option value="US">US</option><option value="EU">EU</option>
          <option value="ASIA">ASIA</option><option value="GLOBAL">GLOBAL</option>
        </select>
        <input placeholder="Company (exact)" value={companyFilter}
          onChange={(e) => setCompanyFilter(e.target.value)} style={{ maxWidth: 160 }} />
        <label style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>From</label>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ maxWidth: 150 }} title="ET date" />
        <label style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>To</label>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ maxWidth: 150 }} title="ET date" />
        <button className={isTodayOnly ? '' : 'secondary'} onClick={resetToToday}
          style={{ fontSize: '0.82rem' }} title="Show only today's jobs (ET)">Today</button>
        {(dateFrom || dateTo) && (
          <button className="secondary" onClick={showAllDates} style={{ fontSize: '0.82rem' }} title="Remove the date filter">All dates</button>
        )}
        <label style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Group by</label>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} style={{ maxWidth: 120 }}>
          <option value="day">Day</option>
          <option value="region">Region</option>
          <option value="status">Status</option>
          <option value="company">Company</option>
        </select>
        {hasExtraFilters && (
          <button className="secondary" onClick={resetToToday} style={{ fontSize: '0.82rem' }}>Clear filters</button>
        )}
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.85rem',
          marginLeft: 'auto', cursor: 'pointer',
          color: reportedOnly ? 'var(--danger, #dc2626)' : 'var(--text)', fontWeight: reportedOnly ? 700 : 400,
        }}>
          <input type="checkbox" checked={reportedOnly} onChange={(e) => setReportedOnly(e.target.checked)} />
          ⚑ Reported only
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
            <div className="field"><label>Company</label><input value={newJob.company} onChange={(e) => setNewJob({ ...newJob, company: e.target.value })} /></div>
            <div className="field"><label>Job title</label><input value={newJob.job_title} onChange={(e) => setNewJob({ ...newJob, job_title: e.target.value })} /></div>
          </div>
          <div className="row">
            <div className="field"><label>Link</label><input value={newJob.link} onChange={(e) => setNewJob({ ...newJob, link: e.target.value })} /></div>
            <div className="field"><label>Region</label>
              <select value={newJob.region} onChange={(e) => setNewJob({ ...newJob, region: e.target.value })}>
                <option value="US">US</option><option value="EU">EU</option><option value="ASIA">ASIA</option><option value="GLOBAL">GLOBAL</option>
              </select>
            </div>
          </div>
          <div className="field"><label>Description</label><textarea rows={8} value={newJob.description} onChange={(e) => setNewJob({ ...newJob, description: e.target.value })} /></div>
          <div className="field">
            <label>Application questions (one per line)</label>
            <textarea rows={4} value={newJob.note} onChange={(e) => setNewJob({ ...newJob, note: e.target.value })}
              placeholder={'Why are you a strong fit for this role?\nTell us about your most relevant experience.\nWhy do you want to work here?'} />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => handleCreate(false)} disabled={!newJob.company || !newJob.job_title || createMutation.isPending}>
              {createMutation.isPending ? <span className="spinner" /> : 'Save'}
            </button>
            <button className="secondary" onClick={() => handleCreate(true)}
              disabled={!newJob.company || !newJob.job_title || createMutation.isPending}
              title="Save this job and keep the form open for the next one">
              {createMutation.isPending ? <span className="spinner" /> : 'Save & Add Another'}
            </button>
            {!isAdmin && <span className="muted" style={{ fontSize: '0.85rem' }}>Will be submitted for admin approval.</span>}
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
              <th>Company</th><th>Job title</th><th>Region</th><th>Status</th>
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
                      </td>
                      <td>{job.link ? <a href={job.link} target="_blank" rel="noreferrer">{job.job_title}</a> : job.job_title}</td>
                      <td>{job.region}</td>
                      <td><span className={`pill ${job.status}`}>{job.status}</span></td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>{formatDate(job.submitted_at || job.approved_at)}</td>
                      {isAdmin && (
                        <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                          {job.created_by_username || (job.source === 'sync' ? <span className="muted">Sync</span> : <span className="muted">—</span>)}
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
                              style={{ padding: '0.25rem 0.4rem', fontSize: '0.82rem' }}>
                              <option value="approved">approved</option>
                              <option value="pending">pending</option>
                              <option value="rejected">rejected</option>
                              <option value="deleted">deleted</option>
                            </select>
                            <button className="secondary" onClick={() => editingId === job.id ? setEditingId(null) : startEdit(job)}>
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
                            <div className="field"><label>Company</label><input value={editDraft.company} onChange={(e) => setEditDraft({ ...editDraft, company: e.target.value })} /></div>
                            <div className="field"><label>Job title</label><input value={editDraft.job_title} onChange={(e) => setEditDraft({ ...editDraft, job_title: e.target.value })} /></div>
                          </div>
                          <div className="row">
                            <div className="field"><label>Link</label><input value={editDraft.link} onChange={(e) => setEditDraft({ ...editDraft, link: e.target.value })} /></div>
                            <div className="field"><label>Region</label>
                              <select value={editDraft.region} onChange={(e) => setEditDraft({ ...editDraft, region: e.target.value })}>
                                <option value="US">US</option><option value="EU">EU</option><option value="ASIA">ASIA</option><option value="GLOBAL">GLOBAL</option>
                              </select>
                            </div>
                          </div>
                          <div className="field"><label>Description</label><textarea rows={6} value={editDraft.description} onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })} /></div>
                          <div className="field">
                            <label>Application questions (one per line)</label>
                            <textarea rows={4} value={editDraft.note} onChange={(e) => setEditDraft({ ...editDraft, note: e.target.value })} />
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => updateMutation.mutate({ id: job.id, payload: editDraft })} disabled={updateMutation.isPending}>
                              {updateMutation.isPending ? <span className="spinner" /> : 'Save changes'}
                            </button>
                            <button className="secondary" onClick={() => setEditingId(null)}>Cancel</button>
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
