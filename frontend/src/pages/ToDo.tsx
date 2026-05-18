import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

type TodoItem = {
  job: any;
  remaining_profile_ids: string[];
};

export default function ToDo() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['todo'],
    queryFn: () => api.get<{ items: TodoItem[]; profiles: any[] }>('/api/todo'),
  });

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;
  if (error) return <div className="banner error">Failed to load to-do list.</div>;

  const items = data?.items || [];
  const profilesById = Object.fromEntries((data?.profiles || []).map((p) => [p.id, p]));

  return (
    <div>
      <h1>To-Do</h1>
      <p className="muted">Approved jobs that haven't been applied to yet for your assigned profiles.</p>
      {items.length === 0 ? (
        <div className="card">No pending items. <Link to="/jobs">Browse all jobs →</Link></div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Job Title</th>
              <th>Remaining profiles</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.job.id}>
                <td>{it.job.company}</td>
                <td>{it.job.job_title}</td>
                <td>
                  {it.remaining_profile_ids.length === 0
                    ? <span className="muted">all done</span>
                    : it.remaining_profile_ids.map((pid) => (
                        <span key={pid} className="pill" style={{ marginRight: 4 }}>
                          {profilesById[pid]?.name || pid}
                        </span>
                      ))}
                </td>
                <td>
                  <Link to={`/resumes?job_id=${it.job.id}`}><button className="secondary">Generate</button></Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
