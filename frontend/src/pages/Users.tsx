import { useState, useRef, useEffect, Fragment } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { Role } from '../lib/auth';

function fmtWhen(iso?: string): string {
  const s = (iso || '').trim();
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}
/** One label/value pair in the full-profile detail panel. */
function Field({ label, value }: { label: string; value?: React.ReactNode }) {
  const empty = value === undefined || value === null || value === '';
  return (
    <div className="u-field">
      <div className="u-field-lbl">{label}</div>
      <div className="u-field-val">{empty ? <span className="muted">—</span> : value}</div>
    </div>
  );
}

const ALL_ROLES: { value: Role; label: string }[] = [
  { value: 'admin',     label: 'Admin' },
  { value: 'bidder',    label: 'Bidder' },
  { value: 'job_adder', label: 'Job-Adder' },
  { value: 'caller',    label: 'Caller' },
];

/** A multi-select rendered as a dropdown: a button shows the current selection,
 *  clicking opens a panel of checkbox items. Closes on outside click. */
function CheckboxDropdown({
  options, selected, onChange, placeholder = 'None', disabled, summary,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  summary?: (labels: string[]) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const set = new Set(selected || []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function toggle(v: string) {
    const next = new Set(set);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(Array.from(next));
  }

  const selectedLabels = options.filter((o) => set.has(o.value)).map((o) => o.label);
  const text = selectedLabels.length === 0 ? placeholder
    : summary ? summary(selectedLabels)
    : selectedLabels.join(', ');

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block', minWidth: 150 }}>
      <button type="button" className="secondary" disabled={disabled} onClick={() => setOpen((o) => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left' }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.85rem',
          color: selectedLabels.length === 0 ? 'var(--muted)' : 'var(--text)' }}>{text}</span>
        <span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 40,
          minWidth: 190, maxHeight: 280, overflowY: 'auto', padding: 6 }}>
          {options.length === 0 && <div className="muted" style={{ padding: 6, fontSize: '0.85rem' }}>No options</div>}
          {options.map((o) => (
            <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px',
              borderRadius: 6, cursor: 'pointer', fontSize: '0.88rem' }}>
              <input type="checkbox" checked={set.has(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Users() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: users = [], isLoading } = useQuery({ queryKey: ['users'], queryFn: () => api.get<any[]>('/api/users') });
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<any[]>('/api/profiles') });

  const [showForm, setShowForm] = useState(false);
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');   // "see users by role"
  const [expanded, setExpanded] = useState<string | null>(null);       // user whose full profile is open (admin-only view)
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

  function updateRoles(u: any, roles: Role[]) {
    updateMutation.mutate({ id: u.id, payload: { roles } });
  }

  // Per-role counts for the filter chips, and the currently filtered list (a user may hold several roles).
  // Admins are shown only under Admin/All — the bidder / job-adder / caller sub-tabs exclude admins.
  const inRole = (u: any, role: Role) => (u.roles || []).includes(role) && (role === 'admin' || !(u.roles || []).includes('admin'));
  const roleCount = (role: Role) => users.filter((u: any) => inRole(u, role)).length;
  const noRoleCount = users.filter((u: any) => !(u.roles || []).length).length;
  const filtered = roleFilter === 'all' ? users : users.filter((u: any) => inRole(u, roleFilter));
  const profileNames = (ids?: string[]) => (ids || []).map((id) => profiles.find((p: any) => p.id === id)?.name || id).join(', ');

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
            <CheckboxDropdown options={ALL_ROLES} selected={newUser.roles}
              onChange={(roles) => setNewUser({ ...newUser, roles: roles as Role[] })} placeholder="Select roles" />
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

      {/* View users by role */}
      <div style={{ display: 'flex', gap: 6, marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button className={roleFilter === 'all' ? '' : 'secondary'} onClick={() => setRoleFilter('all')}
          style={{ fontSize: '0.82rem', padding: '0.32rem 0.7rem' }}>
          All <span style={{ opacity: 0.6 }}>{users.length}</span>
        </button>
        {ALL_ROLES.map((r) => (
          <button key={r.value} className={roleFilter === r.value ? '' : 'secondary'} onClick={() => setRoleFilter(r.value)}
            style={{ fontSize: '0.82rem', padding: '0.32rem 0.7rem' }}>
            {r.label} <span style={{ opacity: 0.6 }}>{roleCount(r.value)}</span>
          </button>
        ))}
        {noRoleCount > 0 && <span className="muted" style={{ fontSize: '0.78rem', marginLeft: 4 }}>· {noRoleCount} with no role</span>}
      </div>

      {filtered.length === 0 ? (
        <div className="card"><span className="muted">No users with this role.</span></div>
      ) : (
      <table>
        <thead><tr><th>Username</th><th>Name</th><th>Email</th><th>Roles</th><th>Bid method</th><th>Status</th><th>Assigned profiles</th><th></th></tr></thead>
        <tbody>
          {filtered.map((u) => (
            <Fragment key={u.id}>
            <tr>
              <td>
                <button className="ghost u-expand" title="Full profile" onClick={() => setExpanded(expanded === u.id ? null : u.id)}>{expanded === u.id ? '▾' : '▸'}</button>
                {u.username}
              </td>
              <td>{u.full_name}</td>
              <td>{u.email}</td>
              <td><CheckboxDropdown options={ALL_ROLES} selected={u.roles || []}
                onChange={(roles) => updateRoles(u, roles as Role[])} disabled={updateMutation.isPending} placeholder="No roles" /></td>
              <td>
                {(u.roles || []).includes('bidder') ? (
                  <select value={u.bid_method ?? 2}
                    onChange={(e) => updateMutation.mutate({ id: u.id, payload: { bid_method: Number(e.target.value) } })}
                    disabled={updateMutation.isPending} title="Which bidding workflow this bidder sees">
                    <option value={1}>Method 1 · Resumes + Apply</option>
                    <option value={2}>Method 2 · Bid</option>
                  </select>
                ) : <span className="muted">—</span>}
              </td>
              <td>
                <select value={u.status} onChange={(e) => updateMutation.mutate({ id: u.id, payload: { status: e.target.value } })}>
                  <option value="approved">Approved</option><option value="pending">Pending</option><option value="disabled">Disabled</option>
                </select>
              </td>
              <td>
                <CheckboxDropdown
                  options={profiles.map((p: any) => ({ value: p.id, label: p.name }))}
                  selected={u.assigned_profile_ids || []}
                  onChange={(ids) => updateMutation.mutate({ id: u.id, payload: { assigned_profile_ids: ids } })}
                  disabled={updateMutation.isPending}
                  placeholder="No profiles"
                  summary={(labels) => (labels.length > 2 ? `${labels.length} profiles` : labels.join(', '))}
                />
              </td>
              <td>
                <button className="danger" onClick={() => { if (confirm('Delete user?')) deleteMutation.mutate(u.id); }}>Delete</button>
              </td>
            </tr>
            {expanded === u.id && (
              <tr className="u-detail-row">
                <td colSpan={8}>
                  <div className="u-detail">
                    <div className="u-detail-hd">
                      {u.avatar_url
                        ? <img className="u-detail-av" src={u.avatar_url} alt="" />
                        : <span className="u-detail-av u-detail-av--i">{(u.full_name || u.username || '?').trim().split(/\s+/).map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()}</span>}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{u.full_name || <span className="muted">(no name)</span>}</div>
                        <div className="muted" style={{ fontSize: '0.8rem' }}>@{u.username} · {(u.roles || []).join(', ') || 'no role'}</div>
                      </div>
                    </div>
                    <div className="u-detail-grid">
                      <Field label="Email" value={u.email} />
                      <Field label="Country" value={u.country} />
                      <Field label="Time zone" value={u.timezone} />
                      <Field label="Telegram" value={u.telegram} />
                      <Field label="WhatsApp" value={u.whatsapp} />
                      <Field label="Discord" value={u.discord} />
                      <Field label="Status" value={u.status} />
                      {(u.roles || []).includes('bidder') && <Field label="Bid method" value={u.bid_method === 1 ? 'Method 1 · Resumes + Apply' : 'Method 2 · Bid'} />}
                      <Field label="Assigned profiles" value={(u.assigned_profile_ids || []).length ? profileNames(u.assigned_profile_ids) : ''} />
                      <Field label="Created" value={fmtWhen(u.created_at)} />
                      <Field label="Approved" value={fmtWhen(u.approved_at)} />
                      <Field label="User ID" value={<code style={{ fontSize: '0.78rem' }}>{u.id}</code>} />
                    </div>
                    {u.emergency_contacts && (
                      <div className="u-field" style={{ marginTop: 8 }}>
                        <div className="u-field-lbl">Emergency contacts</div>
                        <div className="u-field-val" style={{ whiteSpace: 'pre-wrap' }}>{u.emergency_contacts}</div>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>
      )}
    </div>
  );
}
