import { useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';

export default function Jobs() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [newJob, setNewJob] = useState({ company: '', job_title: '', description: '', link: '', region: 'US', status: 'pending' });

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<any[]>('/api/jobs'),
  });

  const createMutation = useMutation({
    mutationFn: (payload: any) => api.post('/api/jobs', { payload }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      setShowForm(false);
      setNewJob({ company: '', job_title: '', description: '', link: '', region: 'US', status: 'pending' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) => api.patch(`/api/jobs/${id}`, { payload }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/jobs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (statusFilter && j.status !== statusFilter) return false;
      if (!q) return true;
      return (j.company || '').toLowerCase().includes(q) || (j.job_title || '').toLowerCase().includes(q);
    });
  }, [jobs, query, statusFilter]);

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Jobs ({filtered.length})</h1>
        <div style={{ flex: 1 }} />
        <input placeholder="Search company or title…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 280 }} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="">All statuses</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
          <option value="rejected">Rejected</option>
        </select>
        <button onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancel' : '+ New Job'}</button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h2>Create job</h2>
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
          <button onClick={() => createMutation.mutate(newJob)} disabled={createMutation.isPending}>
            {createMutation.isPending ? <span className="spinner" /> : 'Create'}
          </button>
        </div>
      )}

      <table>
        <thead>
          <tr><th>Company</th><th>Job title</th><th>Region</th><th>Status</th><th>Submitted</th><th></th></tr>
        </thead>
        <tbody>
          {filtered.map((job) => (
            <tr key={job.id}>
              <td>{job.company}</td>
              <td>{job.link ? <a href={job.link} target="_blank" rel="noreferrer">{job.job_title}</a> : job.job_title}</td>
              <td>{job.region}</td>
              <td><span className={`pill ${job.status}`}>{job.status}</span></td>
              <td>{(job.submitted_at || '').slice(0, 10)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {user?.is_admin && job.status !== 'approved' && (
                  <button className="secondary" style={{ marginRight: 4 }} onClick={() => updateMutation.mutate({ id: job.id, payload: { status: 'approved' } })}>Approve</button>
                )}
                {user?.is_admin && (
                  <button className="danger" onClick={() => { if (confirm('Delete this job?')) deleteMutation.mutate(job.id); }}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
