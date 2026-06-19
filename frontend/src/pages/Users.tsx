import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { Role } from '../lib/auth';

const ALL_ROLES: { value: Role; label: string }[] = [
  { value: 'admin',     label: 'Admin' },
  { value: 'bidder',    label: 'Bidder' },
  { value: 'job_adder', label: 'Job-Adder' },
];

function RoleCheckboxes({
  selected, onChange, disabled,
}: { selected: Role[]; onChange: (next: Role[]) => void; disabled?: boolean }) {
  const set = new Set(selected || []);
  function toggle(r: Role) {
    const next = new Set(set);
    if (next.has(r)) next.delete(r); else next.add(r);
    onChange(Array.from(next));
  }
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {ALL_ROLES.map((r) => (
        <label key={r.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.85rem', cursor: disabled ? 'not-allowed' : 'pointer' }}>
          <input type="checkbox" disabled={disabled} checked={set.has(r.value)} onChange={() => toggle(r.value)} />
          {r.label}
        </label>
      ))}
    </div>
  );
}

export default function Users() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: users = [], isLoading } = useQuery({ queryKey: ['users'], queryFn: () => api.get<any[]>('/api/users') });
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<any[]>('/api/profiles') });

  const [showForm, setShowForm] = useState(false);
  const [newUser, setNewUser] = useState<{
    username: string; full_name: string; email: string; password: string;
    roles: Role[]; status: string;
  }>({
    username: '', full_name: '', email: '', password: '',
    roles: ['bidder'], status: 'approved',
  });

  const createMutation = useMutation({
    mutationFn: (payload: any) => api.post('/api/users', { payload }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setShowForm(false);
      setNewUser({ username: '', full_name: '', email: '', password: '', roles: ['bidder'], status: 'approved' });
      toast('User created', 'success');
    },
    onError: (e: any) => toast(e?.response?.data?.detail || 'Failed to create user', 'error'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) => api.patch(`/api/users/${id}`, { payload }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (e: any) => toast(e?.response?.data?.detail || 'Failed to update user', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  function toggleProfile(u: any, pid: string) {
    const current = new Set(u.assigned_profile_ids || []);
    if (current.has(pid)) current.delete(pid); else current.add(pid);
    updateMutation.mutate({ id: u.id, payload: { assigned_profile_ids: Array.from(current) } });
  }

  function updateRoles(u: any, roles: Role[]) {
    updateMutation.mutate({ id: u.id, payload: { roles } });
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Users ({users.length})</h1>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancel' : '+ New User'}</button>
      </div>

      {showForm && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>Create user</h2>
          <div className="row">
            <div className="field"><label>Username</label><input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} /></div>
            <div className="field"><label>Full name</label><input value={newUser.full_name} onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })} /></div>
          </div>
          <div className="row">
            <div className="field"><label>Email</label><input value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} /></div>
            <div className="field"><label>Password</label><input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} /></div>
          </div>
          <div className="field">
            <label>Roles</label>
            <RoleCheckboxes selected={newUser.roles} onChange={(roles) => setNewUser({ ...newUser, roles })} />
          </div>
          <div className="row">
            <div className="field"><label>Status</label>
              <select value={newUser.status} onChange={(e) => setNewUser({ ...newUser, status: e.target.value })}>
                <option value="approved">Approved</option>
                <option value="pending">Pending</option>
              </select>
            </div>
          </div>
          <button onClick={() => createMutation.mutate(newUser)} disabled={createMutation.isPending || newUser.roles.length === 0}>
            {createMutation.isPending ? <span className="spinner" /> : 'Create'}
          </button>
        </div>
      )}

      <table>
        <thead><tr><th>Username</th><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th>Assigned profiles</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>{u.full_name}</td>
              <td>{u.email}</td>
              <td><RoleCheckboxes selected={u.roles || []} onChange={(roles) => updateRoles(u, roles)} disabled={updateMutation.isPending} /></td>
              <td>
                <select value={u.status} onChange={(e) => updateMutation.mutate({ id: u.id, payload: { status: e.target.value } })}>
                  <option value="approved">Approved</option><option value="pending">Pending</option><option value="disabled">Disabled</option>
                </select>
              </td>
              <td>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {profiles.map((p: any) => {
                    const assigned = (u.assigned_profile_ids || []).includes(p.id);
                    return (
                      <span key={p.id} className="pill" style={{ cursor: 'pointer', opacity: assigned ? 1 : 0.4 }}
                            onClick={() => toggleProfile(u, p.id)}>
                        {p.name}
                      </span>
                    );
                  })}
                </div>
              </td>
              <td>
                <button className="danger" onClick={() => { if (confirm('Delete user?')) deleteMutation.mutate(u.id); }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
