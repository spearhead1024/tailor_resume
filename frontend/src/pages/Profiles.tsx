import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

function ReadValue({ value }: { value: string }) {
  return <div style={{ padding: '0.4rem 0', minHeight: '1.5rem', whiteSpace: 'pre-wrap', userSelect: 'text' }}>{value || <span className="muted">—</span>}</div>;
}

export default function Profiles() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = !!user?.is_admin;
  const [selected, setSelected] = useState<any | null>(null);
  const [editing, setEditing] = useState(false);
  const [bulletCounts, setBulletCounts] = useState<number[]>([]);

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<any[]>('/api/profiles'),
  });

  const saveMutation = useMutation({
    mutationFn: (p: any) => p.id
      ? api.patch(`/api/profiles/${p.id}`, { payload: p })
      : api.post('/api/profiles', { payload: p }),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setSelected(data);
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/profiles/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['profiles'] }); setSelected(null); },
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.post(`/api/profiles/${id}/upload-resume`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
  });

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  function handleSelect(p: any) {
    setSelected({ ...p });
    setBulletCounts((p.generation_settings?.bullet_counts || []).map(Number));
    setEditing(false);
  }

  function handleNew() {
    setSelected({
      id: '',
      name: '',
      email: '',
      phone: '',
      location: '',
      linkedin: '',
      portfolio: '',
      work_history: [],
      education_history: [],
      resume_template: 'spear-1',
      status: 'active',
      total_years_of_experience: 0,
      generation_settings: { skills_count: 85, bullet_counts: [] },
    });
    setBulletCounts([]);
    setEditing(true);
  }

  function handleEdit() {
    setBulletCounts((selected.generation_settings?.bullet_counts || []).map(Number));
    setEditing(true);
  }

  function handleSave() {
    const payload = {
      ...selected,
      total_years_of_experience: Number(selected.total_years_of_experience) || 0,
      generation_settings: {
        skills_count: Number(selected.generation_settings?.skills_count) || 85,
        bullet_counts: bulletCounts,
      },
    };
    saveMutation.mutate(payload);
  }

  const workHistory: any[] = selected?.work_history || [];

  return (
    <div>
      <h1>Profiles</h1>
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '1rem' }}>
        {/* Sidebar */}
        <div className="card" style={{ padding: 0 }}>
          {isAdmin && (
            <div style={{ padding: '0.75rem' }}>
              <button style={{ width: '100%' }} onClick={handleNew}>+ New Profile</button>
            </div>
          )}
          <div>
            {profiles.map((p) => (
              <div key={p.id}
                onClick={() => handleSelect(p)}
                style={{ padding: '0.7rem 1rem', cursor: 'pointer', borderBottom: '1px solid var(--border)', background: selected?.id === p.id ? 'var(--panel-2)' : '' }}>
                <div style={{ fontWeight: 600 }}>{p.name || '(unnamed)'}</div>
                <div className="muted" style={{ fontSize: '0.8rem' }}>{p.email}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail panel */}
        <div className="card">
          {!selected ? (
            <p className="muted">Select a profile to view details.</p>
          ) : (
            <div>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
                <h2 style={{ margin: 0 }}>{editing ? (selected.id ? 'Edit profile' : 'New profile') : selected.name}</h2>
                {!editing && selected.id && (
                  <span className={`pill ${selected.status === 'restricted' ? 'rejected' : 'approved'}`}>
                    {(selected.status || 'active').toUpperCase()}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {isAdmin && !editing && (
                  <>
                    <button onClick={handleEdit} className="secondary">Edit</button>
                    {selected.id && (
                      <button className="danger" style={{ marginLeft: 6 }}
                        onClick={() => { if (confirm('Delete profile?')) deleteMutation.mutate(selected.id); }}>
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Personal info */}
              <div className="row">
                <Field label="Full name">
                  {editing
                    ? <input value={selected.name || ''} onChange={(e) => setSelected({ ...selected, name: e.target.value })} />
                    : <ReadValue value={selected.name} />}
                </Field>
                <Field label="Email">
                  {editing
                    ? <input value={selected.email || ''} onChange={(e) => setSelected({ ...selected, email: e.target.value })} />
                    : <ReadValue value={selected.email} />}
                </Field>
              </div>
              <div className="row">
                <Field label="Phone">
                  {editing
                    ? <input value={selected.phone || ''} onChange={(e) => setSelected({ ...selected, phone: e.target.value })} />
                    : <ReadValue value={selected.phone} />}
                </Field>
                <Field label="Location">
                  {editing
                    ? <input value={selected.location || ''} onChange={(e) => setSelected({ ...selected, location: e.target.value })} />
                    : <ReadValue value={selected.location} />}
                </Field>
              </div>
              <div className="row">
                <Field label="LinkedIn">
                  {editing
                    ? <input value={selected.linkedin || ''} onChange={(e) => setSelected({ ...selected, linkedin: e.target.value })} />
                    : <ReadValue value={selected.linkedin} />}
                </Field>
                <Field label="Portfolio / GitHub">
                  {editing
                    ? <input value={selected.portfolio || ''} onChange={(e) => setSelected({ ...selected, portfolio: e.target.value })} />
                    : <ReadValue value={selected.portfolio} />}
                </Field>
              </div>
              <div className="row">
                <Field label="Resume template">
                  {editing
                    ? (
                      <select value={selected.resume_template || 'spear-1'} onChange={(e) => setSelected({ ...selected, resume_template: e.target.value })}>
                        <option value="spear-1">spear-1 (blue)</option>
                        <option value="spear-2">spear-2 (black)</option>
                      </select>
                    )
                    : <ReadValue value={selected.resume_template || 'spear-1'} />}
                </Field>
                <Field label="Status">
                  {editing
                    ? (
                      <select value={selected.status || 'active'}
                        onChange={(e) => setSelected({ ...selected, status: e.target.value })}>
                        <option value="active">Active</option>
                        <option value="restricted">Restricted</option>
                      </select>
                    )
                    : <ReadValue value={(selected.status || 'active').toUpperCase()} />}
                </Field>
              </div>

              {/* Work history */}
              <Field label="Work history (JSON)">
                {editing
                  ? (
                    <textarea rows={6} value={JSON.stringify(selected.work_history || [], null, 2)}
                      onChange={(e) => {
                        try {
                          const wh = JSON.parse(e.target.value);
                          setSelected({ ...selected, work_history: wh });
                          setBulletCounts((prev) => {
                            const next = [...prev];
                            while (next.length < wh.length) next.push(10);
                            return next.slice(0, wh.length);
                          });
                        } catch {}
                      }} />
                  )
                  : <textarea rows={6} readOnly value={JSON.stringify(selected.work_history || [], null, 2)} style={{ userSelect: 'text' }} />}
              </Field>

              {/* Education history */}
              <Field label="Education history (JSON)">
                {editing
                  ? (
                    <textarea rows={4} value={JSON.stringify(selected.education_history || [], null, 2)}
                      onChange={(e) => { try { setSelected({ ...selected, education_history: JSON.parse(e.target.value) }); } catch {} }} />
                  )
                  : <textarea rows={4} readOnly value={JSON.stringify(selected.education_history || [], null, 2)} style={{ userSelect: 'text' }} />}
              </Field>

              {/* Uploaded DOCX */}
              {selected.id && (
                <Field label="Uploaded resume DOCX template">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="muted">{selected.uploaded_resume_filename || selected.uploaded_resume?.filename || '(none)'}</span>
                    {isAdmin && (
                      <input type="file" accept=".docx" onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadMutation.mutate({ id: selected.id, file: f });
                      }} style={{ maxWidth: 280 }} />
                    )}
                  </div>
                </Field>
              )}

              {/* Generation settings — admin edit only */}
              {isAdmin && editing && (
                <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Generation settings</div>
                  <div className="row">
                    <Field label="Total years of experience">
                      <input type="number" min={0} max={50}
                        value={selected.total_years_of_experience ?? 0}
                        onChange={(e) => setSelected({ ...selected, total_years_of_experience: Number(e.target.value) })} />
                    </Field>
                    <Field label="Skills count (target)">
                      <input type="number" min={80} max={100}
                        value={selected.generation_settings?.skills_count ?? 85}
                        onChange={(e) => setSelected({ ...selected, generation_settings: { ...selected.generation_settings, skills_count: Number(e.target.value) } })} />
                    </Field>
                  </div>
                  {workHistory.length > 0 && (
                    <Field label="Bullet count per company (most recent first)">
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {workHistory.map((job: any, i: number) => (
                          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                            <span className="muted" style={{ fontSize: '0.75rem', maxWidth: 80, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {job.company_name || `Co.${i + 1}`}
                            </span>
                            <input type="number" min={1} max={20} style={{ width: 60 }}
                              value={bulletCounts[i] ?? (i === 0 ? 14 : i < 3 ? 10 : 8)}
                              onChange={(e) => {
                                const next = [...bulletCounts];
                                next[i] = Number(e.target.value);
                                setBulletCounts(next);
                              }} />
                          </div>
                        ))}
                      </div>
                    </Field>
                  )}
                </div>
              )}

              {/* Generation settings — view mode (admin only, read-only display) */}
              {isAdmin && !editing && selected.id && (
                <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Generation settings</div>
                  <div className="row">
                    <Field label="Total years of experience"><ReadValue value={String(selected.total_years_of_experience ?? 0)} /></Field>
                    <Field label="Skills count"><ReadValue value={String(selected.generation_settings?.skills_count ?? 85)} /></Field>
                  </div>
                  {(selected.generation_settings?.bullet_counts || []).length > 0 && (
                    <Field label="Bullet counts per company">
                      <ReadValue value={(selected.generation_settings.bullet_counts as number[]).join(', ')} />
                    </Field>
                  )}
                </div>
              )}

              {editing && (
                <div style={{ marginTop: '1rem', display: 'flex', gap: 8 }}>
                  <button onClick={handleSave} disabled={saveMutation.isPending}>
                    {saveMutation.isPending ? <span className="spinner" /> : 'Save profile'}
                  </button>
                  <button className="secondary" onClick={() => { setEditing(false); handleSelect(selected); }}>Cancel</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
