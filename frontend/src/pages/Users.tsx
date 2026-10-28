import { useState, useRef, useEffect, Fragment } from 'react';
import { useUrlState } from '../lib/urlState';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { Role, useAuth } from '../lib/auth';
import { TimezonePicker } from '../lib/TimezonePicker';

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

/** An inline-editable field: a labelled input that commits on blur when the value actually changed.
 *  Used by admins in the Users detail panel to edit any of a user's plain-text fields in place. */
function EditField({ label, value, onSave, type = 'text', placeholder }: {
  label: string; value: string; onSave: (v: string) => void; type?: string; placeholder?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);   // re-seed when the query refreshes
  return (
    <div className="u-field">
      <div className="u-field-lbl">{label}</div>
      <div className="u-field-val">
        <input type={type} value={v} placeholder={placeholder} style={{ width: '100%' }}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => { if (v !== value) onSave(v); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </div>
    </div>
  );
}

const ALL_ROLES: { value: Role; label: string }[] = [
  { value: 'admin',     label: 'Admin' },
  { value: 'bidder',    label: 'Bidder' },
  { value: 'job_adder', label: 'Job-Adder' },
  { value: 'caller',    label: 'Caller' },
  { value: 'manager',   label: 'Team Manager' },
  { value: 'call_board_manager', label: 'Call Board Manager' },
];

type Team = { id: string; name: string };

const roleSet = (u: any): Set<string> => new Set<string>(u?.roles || []);
const isCaller = (u: any) => roleSet(u).has('caller') && !roleSet(u).has('admin');
const isTeamManager = (u: any) => roleSet(u).has('manager') && !roleSet(u).has('admin');
const teamOf = (u: any) => String(u?.team_id || '').trim();

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

/** Search-and-add picker for team members — the "add a tag/skill" pattern. A button
 *  opens a dropdown that lists the CANDIDATE callers (unassigned to any team),
 *  searchable by name/username; clicking one adds it. Closes on outside click. */
function AddMemberPicker({ candidates, onAdd, disabled }: {
  candidates: { id: string; name: string; username: string }[];
  onAdd: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEffect(() => { if (open) { setQ(''); setHl(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = terms.length
    ? candidates.filter((c) => { const s = `${c.name} ${c.username}`.toLowerCase(); return terms.every((t) => s.includes(t)); })
    : candidates;
  const pick = (id: string) => { onAdd(id); setOpen(false); };

  return (
    <div ref={ref} className="tz-picker" style={{ display: 'inline-block' }}>
      <button type="button" className="secondary" disabled={disabled}
        onClick={() => setOpen((o) => !o)} style={{ fontSize: '0.8rem', padding: '0.25rem 0.7rem' }}>
        + Add caller ▾
      </button>
      {open && (
        <div className="card tz-menu" style={{ minWidth: 240 }}>
          <input ref={inputRef} className="tz-search" value={q} placeholder="Search unassigned callers…"
            onChange={(e) => { setQ(e.target.value); setHl(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(filtered.length - 1, h + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); if (filtered[hl]) pick(filtered[hl].id); }
              else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
            }} />
          <div className="tz-list">
            {filtered.length === 0 && <div className="muted" style={{ padding: 8, fontSize: '0.82rem' }}>
              {candidates.length === 0 ? 'No unassigned callers' : 'No matches'}
            </div>}
            {filtered.map((c, i) => (
              <div key={c.id} className={'tz-opt' + (i === hl ? ' tz-opt--hl' : '')}
                onMouseEnter={() => setHl(i)} onClick={() => pick(c.id)}>
                {c.name || c.username} <span className="muted">@{c.username}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Users() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const isAdmin = !!me?.is_admin;
  const myTeam = String(me?.team_id || '').trim();

  const { data: allUsers = [], isLoading } = useQuery({ queryKey: ['users'], queryFn: () => api.get<any[]>('/api/users') });
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<any[]>('/api/profiles') });
  const { data: teams = [] } = useQuery({ queryKey: ['teams'], queryFn: () => api.get<Team[]>('/api/teams') });

  // VPS_1 users are never shown here — this tab manages VPS_2 accounts only.
  const users = allUsers.filter((u: any) => u.source !== 'VPS_1');

  const [showForm, setShowForm] = useState(false);
  const [roleFilter, setRoleFilter] = useUrlState<Role | 'teams'>('tab', 'teams');   // sub-tab: Teams or a role (in the URL)
  const [newTeamName, setNewTeamName] = useState('');

  const afterTeams = () => { qc.invalidateQueries({ queryKey: ['teams'] }); qc.invalidateQueries({ queryKey: ['users'] }); };
  const createTeam = useMutation({
    mutationFn: (name: string) => api.post('/api/teams', { name }),
    onSuccess: () => { afterTeams(); setNewTeamName(''); toast('Team created', 'success'); },
    onError: (e: any) => toast(e?.response?.data?.detail || 'Failed to create team', 'error'),
  });
  const renameTeam = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch(`/api/teams/${id}`, { name }),
    onSuccess: () => { afterTeams(); toast('Team renamed', 'success'); },
    onError: (e: any) => toast(e?.response?.data?.detail || 'Failed to rename team', 'error'),
  });
  const removeTeam = useMutation({
    mutationFn: (id: string) => api.delete(`/api/teams/${id}`),
    onSuccess: () => { afterTeams(); toast('Team deleted — its members are now ungrouped', 'success'); },
    onError: (e: any) => toast(e?.response?.data?.detail || 'Failed to delete team', 'error'),
  });
  const [expanded, setExpanded] = useState<string | null>(null);       // user whose full profile is open (admin-only view)
  const [pwFor, setPwFor] = useState<Record<string, string>>({});       // per-user "set new password" input
  const cvInputRef = useRef<HTMLInputElement>(null);                     // admin CV upload (one row expanded at a time)
  const [techQuery, setTechQuery] = useUrlState('tech', '');            // caller sub-tab: filter by tech stack
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

  // Admin uploads/replaces a caller's CV on their behalf (the caller can also do it themselves on their
  // Account page). Multipart, so use api.raw to let the browser set the boundary.
  const cvUpload = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const fd = new FormData(); fd.append('file', file);
      return api.raw.post(`/api/auth/users/${id}/resume`, fd);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); toast('CV uploaded', 'success'); },
    onError: (e: any) => toast(e?.response?.data?.detail || 'Failed to upload CV', 'error'),
  });
  const cvRemove = useMutation({
    mutationFn: (id: string) => api.raw.delete(`/api/auth/users/${id}/resume`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); toast('CV removed', 'success'); },
    onError: (e: any) => toast(e?.response?.data?.detail || 'Failed to remove CV', 'error'),
  });

  // Open a CV. The download endpoint is auth-gated (admin/self), but a plain <a href> navigates WITHOUT
  // the token (it lives in localStorage, not a cookie) → 401. So fetch it as a blob through api.raw
  // (which injects the Bearer header) and open the object URL, the same way the Applied tab opens PDFs.
  const openCv = async (id: string) => {
    try {
      const res = await api.raw.get(`/api/auth/users/${id}/resume`, { responseType: 'blob' });
      const blob = res.data as Blob;
      if (!blob || blob.size === 0) throw new Error('empty');
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e: any) {
      let msg = 'Failed to open CV';
      try { msg = JSON.parse(await e?.response?.data?.text())?.detail || msg; } catch { /* */ }
      toast(msg, 'error');
    }
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (e: any) => toast(e?.response?.data?.detail || 'Failed to delete user', 'error'),
  });

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  function updateRoles(u: any, roles: Role[]) {
    if (!roles.length) { toast('A user needs at least one role.', 'error'); return; }
    updateMutation.mutate({ id: u.id, payload: { roles } });
  }

  // Per-role counts for the filter chips, and the currently filtered list (a user may hold several roles).
  // Admins are shown only under Admin/All — the bidder / job-adder / caller sub-tabs exclude admins.
  const inRole = (u: any, role: Role) => (u.roles || []).includes(role) && (role === 'admin' || !(u.roles || []).includes('admin'));
  const roleCount = (role: Role) => users.filter((u: any) => inRole(u, role)).length;
  const noRoleCount = users.filter((u: any) => !(u.roles || []).length).length;
  const filtered = (() => {
    let list = roleFilter === 'teams'
      ? users
      : users.filter((u: any) => inRole(u, roleFilter));
    // Caller sub-tab: narrow by tech stack. Every search term must match some stack (AND), each term a
    // case-insensitive substring — so "react node" finds callers who have both.
    if (roleFilter === 'caller' && techQuery.trim()) {
      const terms = techQuery.toLowerCase().split(/[,\s]+/).filter(Boolean);
      list = list.filter((u: any) => {
        const stacks = (u.tech_stacks || []).map((s: string) => s.toLowerCase());
        return terms.every((t) => stacks.some((s: string) => s.includes(t)));
      });
    }
    return list;
  })();
  const callerView = roleFilter === 'caller';   // the caller sub-tab swaps two columns for tech + CV

  // Which columns each role sub-tab shows. Source is gone everywhere (VPS_1 users
  // are filtered out). Name/Email hide on the caller view (checked in the dropdown).
  //   Team column:     callers + team managers only  (admins/bidders/job-adders don't belong to a team)
  //   Assigned profiles: bidders + call-board managers only (admins/job-adders/managers don't apply to jobs)
  const showTeamCol = roleFilter === 'caller' || roleFilter === 'manager';
  const showAssignedCol = roleFilter === 'bidder' || roleFilter === 'call_board_manager';
  const showNameEmail = !callerView;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>{isAdmin ? `Users (${users.length})` : `My team (${users.length})`}</h1>
        <div style={{ flex: 1 }} />
        {/* Creating an account is admin-only (the API says so too — see create_user). A manager still
            opens this tab to see and edit their own team, so the tab stays; only this goes. */}
        {isAdmin && (
          <button onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Cancel' : '+ New User'}
          </button>
        )}
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
        <button className={roleFilter === 'teams' ? '' : 'secondary'} onClick={() => setRoleFilter('teams')}
          style={{ fontSize: '0.82rem', padding: '0.32rem 0.7rem' }}>
          Teams <span style={{ opacity: 0.6 }}>{teams.length}</span>
        </button>
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border, #2a2a2a)', margin: '0 2px' }} />
        {ALL_ROLES.map((r) => (
          <button key={r.value} className={roleFilter === r.value ? '' : 'secondary'} onClick={() => setRoleFilter(r.value)}
            style={{ fontSize: '0.82rem', padding: '0.32rem 0.7rem' }}>
            {r.label} <span style={{ opacity: 0.6 }}>{roleCount(r.value)}</span>
          </button>
        ))}
        {noRoleCount > 0 && <span className="muted" style={{ fontSize: '0.78rem', marginLeft: 4 }}>· {noRoleCount} with no role</span>}
      </div>

      {/* Caller sub-tab only: find callers by tech stack. */}
      {roleFilter === 'caller' && (
        <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input value={techQuery} onChange={(e) => setTechQuery(e.target.value)}
            placeholder="Search callers by tech stack — e.g. React, Go" style={{ maxWidth: 360 }} />
          {techQuery && <button className="ghost" onClick={() => setTechQuery('')} style={{ fontSize: '0.82rem' }}>Clear</button>}
          <span className="muted" style={{ fontSize: '0.8rem' }}>{filtered.length} match{filtered.length === 1 ? '' : 'es'}</span>
        </div>
      )}

      {/* ── Teams tree: ungrouped callers at the top level, then each team as an expandable group ── */}
      {roleFilter === 'teams' && (() => {
        const callers = users.filter(isCaller);
        const unassigned = callers
          .filter((u: any) => !teamOf(u))
          .map((u: any) => ({ id: u.id, name: u.full_name || u.username, username: u.username }));
        const addToTeam = (uid: string, team_id: string) => updateMutation.mutate({ id: uid, payload: { team_id } });
        const removeFromTeam = (uid: string) => updateMutation.mutate({ id: uid, payload: { team_id: '' } });

        return (
          <>
            <p className="muted">
              Each <strong>Team</strong> is a set of callers run by a <strong>Team Manager</strong>. Add callers to a
              team from the unassigned list; remove one with the ✕ on its chip (it becomes unassigned — no account is
              deleted). On the interview board a manager can hand a call to any caller on their team.
            </p>

            {isAdmin && (
              <div className="card" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                <input placeholder="New team name — e.g. Vaccine Team" value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newTeamName.trim()) createTeam.mutate(newTeamName.trim()); }}
                  style={{ maxWidth: 280 }} />
                <button onClick={() => createTeam.mutate(newTeamName.trim())}
                  disabled={!newTeamName.trim() || createTeam.isPending}>
                  {createTeam.isPending ? <span className="spinner" /> : '+ Create team'}
                </button>
                <span style={{ flex: 1 }} />
                <span className="muted" style={{ fontSize: '0.8rem' }}>{unassigned.length} unassigned caller{unassigned.length === 1 ? '' : 's'}</span>
              </div>
            )}

            {/* One card per team: header (name · counts · manage) then member chips + add-picker. */}
            {teams.map((t) => {
              const members = callers.filter((u: any) => teamOf(u) === t.id);
              const mgrs = users.filter((u: any) => isTeamManager(u) && teamOf(u) === t.id);
              return (
                <div key={t.id} className="card" style={{ marginBottom: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: members.length || isAdmin ? 10 : 0 }}>
                    <strong>{t.name}</strong>
                    <span className="muted" style={{ fontSize: '0.8rem' }}>
                      {members.length} caller{members.length === 1 ? '' : 's'}
                      {mgrs.length > 0 ? <> · manager: {mgrs.map((m: any) => m.full_name || m.username).join(', ')}</> : <> · <em>no manager</em></>}
                    </span>
                    <span style={{ flex: 1 }} />
                    {isAdmin && (
                      <>
                        <button className="secondary" style={{ fontSize: '0.78rem', padding: '0.25rem 0.6rem' }}
                          onClick={() => { const n = prompt('Rename team', t.name); if (n && n.trim() && n.trim() !== t.name) renameTeam.mutate({ id: t.id, name: n.trim() }); }}>
                          Rename
                        </button>
                        <button className="danger" style={{ fontSize: '0.78rem', padding: '0.25rem 0.6rem' }}
                          onClick={() => { if (confirm(`Delete "${t.name}"? Its ${members.length} caller(s) become unassigned — no account is deleted.`)) removeTeam.mutate(t.id); }}>
                          Delete
                        </button>
                      </>
                    )}
                  </div>

                  {/* member chips + add-picker (the "add skills" pattern) */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {members.length === 0 && <span className="muted" style={{ fontSize: '0.82rem' }}>No callers yet.</span>}
                    {members.map((u: any) => (
                      <span key={u.id} title={`@${u.username}${u.status !== 'approved' ? ` · ${u.status}` : ''}`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem',
                          background: 'var(--panel-2, #262626)', border: '1px solid var(--border-soft, #333)',
                          borderRadius: 999, padding: '2px 4px 2px 10px', opacity: u.status === 'approved' ? 1 : 0.6 }}>
                        {u.full_name || u.username}
                        {isAdmin && (
                          <button className="ghost" title="Remove from team" disabled={updateMutation.isPending}
                            onClick={() => removeFromTeam(u.id)}
                            style={{ padding: '0 4px', lineHeight: 1, fontSize: '0.9rem', color: 'var(--muted)' }}>✕</button>
                        )}
                      </span>
                    ))}
                    {isAdmin && (
                      <AddMemberPicker candidates={unassigned} disabled={updateMutation.isPending}
                        onAdd={(uid) => addToTeam(uid, t.id)} />
                    )}
                  </div>
                </div>
              );
            })}

            {teams.length === 0 && (
              <div className="card"><span className="muted">No teams yet{isAdmin ? ' — create one above.' : '.'}</span></div>
            )}
          </>
        );
      })()}

      {roleFilter !== 'teams' && (filtered.length === 0 ? (
        <div className="card"><span className="muted">No users with this role.</span></div>
      ) : (
      <table>
        {/* Columns are role-specific (see showTeamCol / showAssignedCol above). The caller
            view shows Tech skills + Resume; other roles show only what applies to them. */}
        <thead><tr>
          <th>Username</th>
          {showNameEmail && <><th>Name</th><th>Email</th></>}
          <th>Roles</th>
          {showTeamCol && <th>Team</th>}
          {callerView && <th style={{ minWidth: 280 }}>Tech skills</th>}
          <th>Status</th>
          {callerView && <th>Resume</th>}
          {showAssignedCol && <th>Assigned profiles</th>}
          <th></th>
        </tr></thead>
        <tbody>
          {filtered.map((u) => (
            <Fragment key={u.id}>
            <tr>
              <td>
                <button className="ghost u-expand" title="Full profile" onClick={() => setExpanded(expanded === u.id ? null : u.id)}>{expanded === u.id ? '▾' : '▸'}</button>
                {u.username}
              </td>
              {showNameEmail && <><td>{u.full_name}</td><td>{u.email}</td></>}
              <td><CheckboxDropdown options={ALL_ROLES} selected={u.roles || []}
                    onChange={(roles) => updateRoles(u, roles as Role[])}
                    disabled={!isAdmin || updateMutation.isPending} placeholder="No roles" /></td>
              {showTeamCol && (
                <td>
                  {/* Team for callers and managers — a manager's team is the one they run. */}
                  {(isCaller(u) || isTeamManager(u)) ? (
                    <select value={teamOf(u)} disabled={!isAdmin || updateMutation.isPending}
                      onChange={(e) => updateMutation.mutate({ id: u.id, payload: { team_id: e.target.value } })}
                      title={isTeamManager(u) ? 'The team this manager runs' : 'The team this caller belongs to'}>
                      <option value="">— none —</option>
                      {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  ) : <span className="muted">—</span>}
                </td>
              )}
              {callerView && (
                <td>
                  {(u.tech_stacks || []).length
                    ? <span title={(u.tech_stacks || []).join(', ')}>{(u.tech_stacks || []).join(', ')}</span>
                    : <span className="muted">—</span>}
                </td>
              )}
              <td>
                <select value={u.status} onChange={(e) => updateMutation.mutate({ id: u.id, payload: { status: e.target.value } })}>
                  <option value="approved">Approved</option><option value="pending">Pending</option><option value="disabled">Disabled</option>
                </select>
              </td>
              {callerView && (
                <td>
                  {u.uploaded_resume?.filename
                    ? <button className="link" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                        title={u.uploaded_resume.filename} onClick={() => openCv(u.id)}>📄 CV</button>
                    : <span className="muted">—</span>}
                </td>
              )}
              {showAssignedCol && (
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
              )}
              <td>
                {isAdmin && u.id === me?.id
                  ? <span className="muted" title="You can't delete your own account.">—</span>
                  : isAdmin
                  ? <button className="danger" onClick={() => { if (confirm('Delete user?')) deleteMutation.mutate(u.id); }}>Delete</button>
                  : <span className="muted" title="Only an admin can delete an account — you can set the status to Disabled instead.">—</span>}
              </td>
            </tr>
            {expanded === u.id && (
              <tr className="u-detail-row">
                <td colSpan={4 + (showNameEmail ? 2 : 0) + (showTeamCol ? 1 : 0) + (callerView ? 2 : 0) + (showAssignedCol ? 1 : 0)}>
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
                    {/* Admins may edit EVERY field of a user here — each commits on blur through the
                        same PATCH the row controls use. `up` is a tiny shorthand for "save one field". */}
                    {(() => { const up = (payload: any) => updateMutation.mutate({ id: u.id, payload }); return (
                    <>
                    <div className="u-detail-grid">
                      <EditField label="Full name" value={u.full_name || ''} onSave={(v) => up({ full_name: v })} />
                      <EditField label="Email" value={u.email || ''} type="email" onSave={(v) => up({ email: v })} />
                      <EditField label="Country" value={u.country || ''} onSave={(v) => up({ country: v })} />
                      <Field label="Time zone" value={
                        <TimezonePicker value={u.timezone || ''}
                          onChange={(tz) => { if (tz !== (u.timezone || '')) up({ timezone: tz }); }} />
                      } />
                      <EditField label="Telegram" value={u.telegram || ''} onSave={(v) => up({ telegram: v })} placeholder="@handle" />
                      <EditField label="WhatsApp" value={u.whatsapp || ''} onSave={(v) => up({ whatsapp: v })} placeholder="+1 555…" />
                      <EditField label="Discord" value={u.discord || ''} onSave={(v) => up({ discord: v })} placeholder="user#0000" />
                      <Field label="Status" value={u.status} />
                      <Field label="Created" value={fmtWhen(u.created_at)} />
                      <Field label="Approved" value={fmtWhen(u.approved_at)} />
                      <Field label="User ID" value={<code style={{ fontSize: '0.78rem' }}>{u.id}</code>} />
                    </div>

                    {/* Caller CV + tech stacks — admins see these here (the caller sets them on their own
                        Account page). Tech stacks are editable; the CV is view/download only. */}
                    {(u.roles || []).includes('caller') && (
                      <div className="u-detail-grid" style={{ marginTop: 8 }}>
                        <EditField label="Tech stacks" value={(u.tech_stacks || []).join(', ')}
                          placeholder="React, Node.js, Go…"
                          onSave={(v) => up({ tech_stacks: v.split(',').map((s) => s.trim()).filter(Boolean) })} />
                        <Field label="CV / Resume" value={
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            {u.uploaded_resume?.filename
                              ? <button className="link" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                                  onClick={() => openCv(u.id)}>{u.uploaded_resume.filename}</button>
                              : <span className="muted">No CV</span>}
                            {/* Admin may upload/replace a caller's CV (PDF/DOCX). */}
                            {isAdmin && (<>
                              <input ref={cvInputRef} type="file" accept=".pdf,.docx" style={{ display: 'none' }}
                                onChange={(e) => { const f = e.target.files?.[0]; if (f) cvUpload.mutate({ id: u.id, file: f }); e.currentTarget.value = ''; }} />
                              <button className="secondary" disabled={cvUpload.isPending}
                                onClick={() => cvInputRef.current?.click()} style={{ fontSize: '0.8rem', padding: '2px 8px' }}>
                                {cvUpload.isPending ? '…' : (u.uploaded_resume?.filename ? 'Replace' : 'Upload')}
                              </button>
                              {u.uploaded_resume?.filename && (
                                <button className="ghost danger" disabled={cvRemove.isPending}
                                  onClick={() => cvRemove.mutate(u.id)} style={{ fontSize: '0.8rem', padding: '2px 8px' }}>Remove</button>
                              )}
                            </>)}
                          </div>
                        } />
                      </div>
                    )}

                    <div className="u-field" style={{ marginTop: 8 }}>
                      <div className="u-field-lbl">Emergency contacts</div>
                      <textarea rows={2} defaultValue={u.emergency_contacts || ''} style={{ width: '100%' }}
                        placeholder="Name · relationship · phone (one per line)"
                        onBlur={(e) => { if (e.target.value !== (u.emergency_contacts || '')) up({ emergency_contacts: e.target.value }); }} />
                    </div>
                    {/* Set a new password for this user (leave blank to keep the current one). */}
                    <div className="u-field" style={{ marginTop: 8 }}>
                      <div className="u-field-lbl">Set new password</div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input type="text" placeholder="new password (≥ 10 chars)" style={{ maxWidth: 240 }}
                          value={pwFor[u.id] || ''} onChange={(e) => setPwFor((m) => ({ ...m, [u.id]: e.target.value }))} />
                        <button className="secondary" disabled={(pwFor[u.id] || '').length < 10}
                          onClick={() => updateMutation.mutate({ id: u.id, payload: { password: pwFor[u.id] } }, {
                            onSuccess: () => { setPwFor((m) => ({ ...m, [u.id]: '' })); toast('Password updated', 'success'); },
                          })}>
                          Set password
                        </button>
                      </div>
                    </div>
                    </>
                    ); })()}
                  </div>
                </td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>
      ))}
    </div>
  );
}
