import { useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const BLANK_JOB = { company: '', job_title: '', description: '', link: '', region: 'US', note: '' };

/** Surface backend errors gracefully. The duplicate-detect path returns a
 *  structured `detail` object; everything else returns a string. */
function formatJobError(err: any, fallback: string): string {
  const d = err?.response?.data?.detail;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && d.message) return d.message;
  return err?.message || fallback;
}

function formatDay(iso: string): string {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Unknown date';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dayKey(iso: string): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

export default function Jobs() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = !!user?.is_admin;
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('approved');
  const [showForm, setShowForm] = useState(false);
  const [newJob, setNewJob] = useState({ ...BLANK_JOB });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<any>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<any[]>('/api/jobs'),
  });

  const createMutation = useMutation({
    mutationFn: (payload: any) => api.post('/api/jobs', { payload }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      setPage(1);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) => api.patch(`/api/jobs/${id}`, { payload }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      setEditingId(null);
    },
    onError: (e: any) => toast(formatJobError(e, 'Failed to update job'), 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/jobs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  // Sort newest first, then filter
  const sorted = useMemo(() => {
    return [...jobs].sort((a, b) => {
      const ta = a.submitted_at || a.approved_at || '';
      const tb = b.submitted_at || b.approved_at || '';
      return tb.localeCompare(ta);
    });
  }, [jobs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((j) => {
      if (statusFilter && j.status !== statusFilter) return false;
      if (!q) return true;
      return (j.company || '').toLowerCase().includes(q)
        || (j.job_title || '').toLowerCase().includes(q)
        || (j.note || '').toLowerCase().includes(q);
    });
  }, [sorted, query, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageJobs = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Group current page jobs by day
  const groupedPage = useMemo(() => {
    const groups: { day: string; label: string; jobs: any[] }[] = [];
    for (const job of pageJobs) {
      const ts = job.submitted_at || job.approved_at || '';
      const dk = dayKey(ts);
      const last = groups[groups.length - 1];
      if (last && last.day === dk) {
        last.jobs.push(job);
      } else {
        groups.push({ day: dk, label: formatDay(ts), jobs: [job] });
      }
    }
    return groups;
  }, [pageJobs]);

  async function handleCreate(keepOpen = false) {
    const status = isAdmin ? 'approved' : 'pending';
    const label = newJob.company || 'job';
    try {
      await createMutation.mutateAsync({ ...newJob, status });
      setNewJob({ ...BLANK_JOB });
      if (keepOpen) {
        toast(`Saved "${label}" — ready for the next one`, 'success');
      } else {
        setShowForm(false);
        toast(`Saved "${label}"`, 'success');
      }
    } catch (e: any) {
      toast(formatJobError(e, 'Failed to save job'), 'error');
    }
  }

  function startEdit(job: any) {
    setEditingId(job.id);
    setEditDraft({
      company: job.company || '',
      job_title: job.job_title || '',
      link: job.link || '',
      region: job.region || 'US',
      description: job.description || '',
      note: job.note || '',
    });
  }

  function goPage(n: number) {
    setPage(Math.max(1, Math.min(n, totalPages)));
    setEditingId(null);
  }

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  return (
    <div>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Jobs ({filtered.length})</h1>
        <div style={{ flex: 1 }} />
        <input placeholder="Search company, title, or note…" value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1); }}
          style={{ maxWidth: 260 }} />
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} style={{ maxWidth: 160 }}>
          <option value="">All statuses</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
          <option value="rejected">Rejected</option>
        </select>
        <button onClick={() => { setShowForm(!showForm); setNewJob({ ...BLANK_JOB }); }}>
          {showForm ? 'Cancel' : '+ New Job'}
        </button>
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
            <button
              onClick={() => handleCreate(false)}
              disabled={!newJob.company || !newJob.job_title || createMutation.isPending}>
              {createMutation.isPending ? <span className="spinner" /> : 'Save'}
            </button>
            <button
              className="secondary"
              onClick={() => handleCreate(true)}
              disabled={!newJob.company || !newJob.job_title || createMutation.isPending}
              title="Save this job and keep the form open for the next one">
              {createMutation.isPending ? <span className="spinner" /> : 'Save & Add Another'}
            </button>
            {!isAdmin && <span className="muted" style={{ fontSize: '0.85rem' }}>Will be submitted for admin approval.</span>}
          </div>
        </div>
      )}

      {/* Pagination controls — top */}
      {filtered.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          {totalPages > 1 && (
            <>
              <button className="secondary" disabled={safePage === 1} onClick={() => goPage(safePage - 1)}>← Prev</button>
              <span className="muted" style={{ fontSize: '0.9rem' }}>Page {safePage} of {totalPages}</span>
              <button className="secondary" disabled={safePage === totalPages} onClick={() => goPage(safePage + 1)}>Next →</button>
            </>
          )}
          <span className="muted" style={{ fontSize: '0.85rem', marginLeft: totalPages > 1 ? 8 : 0 }}>
            {filtered.length} job{filtered.length === 1 ? '' : 's'} total
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="muted" style={{ fontSize: '0.8rem' }}>Rows</span>
            <select value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              style={{ width: 'auto', padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}>
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Jobs — single table with day separator rows */}
      {filtered.length === 0 ? (
        <div className="card"><span className="muted">No jobs match the current filters.</span></div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Job title</th>
              <th>Region</th>
              <th>Status</th>
              <th style={{ whiteSpace: 'nowrap' }}>AddedAt</th>
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {groupedPage.map((group) => (
              <>
                {/* Day separator */}
                <tr key={`sep-${group.day}`}>
                  <td colSpan={isAdmin ? 6 : 5} style={{
                    padding: '0.5rem 0.75rem',
                    fontWeight: 600,
                    fontSize: '0.85rem',
                    color: 'var(--muted)',
                    background: 'var(--panel-2)',
                    borderTop: '2px solid var(--border)',
                  }}>
                    {group.label} — {group.jobs.length} {group.jobs.length === 1 ? 'job' : 'jobs'}
                  </td>
                </tr>

                {group.jobs.map((job) => (
                  <>
                    <tr key={job.id}>
                      <td>{job.company}</td>
                      <td>
                        {job.link
                          ? <a href={job.link} target="_blank" rel="noreferrer">{job.job_title}</a>
                          : job.job_title}
                      </td>
                      <td>{job.region}</td>
                      <td><span className={`pill ${job.status}`}>{job.status}</span></td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                        {formatDate(job.submitted_at || job.approved_at)}
                      </td>
                      {isAdmin && (
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {job.status !== 'approved' && (
                            <button className="secondary" style={{ marginRight: 4 }}
                              onClick={() => updateMutation.mutate({ id: job.id, payload: { status: 'approved' } })}>
                              Approve
                            </button>
                          )}
                          <button className="secondary" style={{ marginRight: 4 }}
                            onClick={() => editingId === job.id ? setEditingId(null) : startEdit(job)}>
                            {editingId === job.id ? 'Cancel' : 'Edit'}
                          </button>
                          <button className="danger"
                            onClick={() => { if (confirm('Delete this job?')) deleteMutation.mutate(job.id); }}>
                            Delete
                          </button>
                        </td>
                      )}
                    </tr>

                    {editingId === job.id && (
                      <tr key={`${job.id}-edit`}>
                        <td colSpan={isAdmin ? 6 : 5} style={{ padding: '1rem', background: 'var(--panel-2)' }}>
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
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </>
            ))}
          </tbody>
        </table>
      )}

      {/* Pagination controls — bottom */}
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
