import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';

export default function Profiles() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<any | null>(null);
  const [editing, setEditing] = useState(false);

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
      summary_seed: '',
      technical_skills: [],
      work_history: [],
      education_history: [],
      resume_template: 'spear-1',
    });
    setEditing(true);
  }

  return (
    <div>
      <h1>Profiles</h1>
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '1rem' }}>
        <div className="card" style={{ padding: 0 }}>
          {user?.is_admin && (
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

        <div className="card">
          {!selected ? (
            <p className="muted">Select a profile to view details.</p>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 style={{ margin: 0 }}>{editing ? (selected.id ? 'Edit profile' : 'New profile') : selected.name}</h2>
                <div style={{ flex: 1 }} />
                {!editing && (
                  <>
                    <button onClick={() => setEditing(true)} className="secondary">Edit</button>
                    {user?.is_admin && selected.id && (
                      <button className="danger" style={{ marginLeft: 6 }} onClick={() => { if (confirm('Delete profile?')) deleteMutation.mutate(selected.id); }}>Delete</button>
                    )}
                  </>
                )}
              </div>

              <div className="row">
                <div className="field"><label>Full name</label><input disabled={!editing} value={selected.name || ''} onChange={(e) => setSelected({ ...selected, name: e.target.value })} /></div>
                <div className="field"><label>Email</label><input disabled={!editing} value={selected.email || ''} onChange={(e) => setSelected({ ...selected, email: e.target.value })} /></div>
              </div>
              <div className="row">
                <div className="field"><label>Phone</label><input disabled={!editing} value={selected.phone || ''} onChange={(e) => setSelected({ ...selected, phone: e.target.value })} /></div>
                <div className="field"><label>Location</label><input disabled={!editing} value={selected.location || ''} onChange={(e) => setSelected({ ...selected, location: e.target.value })} /></div>
              </div>
              <div className="row">
                <div className="field"><label>LinkedIn</label><input disabled={!editing} value={selected.linkedin || ''} onChange={(e) => setSelected({ ...selected, linkedin: e.target.value })} /></div>
                <div className="field"><label>Portfolio / GitHub</label><input disabled={!editing} value={selected.portfolio || ''} onChange={(e) => setSelected({ ...selected, portfolio: e.target.value })} /></div>
              </div>
              <div className="field">
                <label>Resume template</label>
                <select disabled={!editing} value={selected.resume_template || 'spear-1'} onChange={(e) => setSelected({ ...selected, resume_template: e.target.value })}>
                  <option value="spear-1">spear-1 (blue)</option>
                  <option value="spear-2">spear-2 (black)</option>
                </select>
              </div>
              <div className="field">
                <label>Summary seed</label>
                <textarea disabled={!editing} rows={3} value={selected.summary_seed || ''} onChange={(e) => setSelected({ ...selected, summary_seed: e.target.value })} />
              </div>
              <div className="field">
                <label>Technical skills (comma-separated)</label>
                <textarea disabled={!editing} rows={3}
                  value={(selected.technical_skills || []).join(', ')}
                  onChange={(e) => setSelected({ ...selected, technical_skills: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })} />
              </div>
              <div className="field">
                <label>Work history (JSON)</label>
                <textarea disabled={!editing} rows={6} value={JSON.stringify(selected.work_history || [], null, 2)}
                  onChange={(e) => { try { setSelected({ ...selected, work_history: JSON.parse(e.target.value) }); } catch {} }} />
              </div>
              <div className="field">
                <label>Education history (JSON)</label>
                <textarea disabled={!editing} rows={4} value={JSON.stringify(selected.education_history || [], null, 2)}
                  onChange={(e) => { try { setSelected({ ...selected, education_history: JSON.parse(e.target.value) }); } catch {} }} />
              </div>

              {selected.id && (
                <div className="field">
                  <label>Uploaded resume DOCX template</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="muted">{selected.uploaded_resume_filename || '(none)'}</span>
                    <input type="file" accept=".docx" onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadMutation.mutate({ id: selected.id, file: f });
                    }} style={{ maxWidth: 280 }} />
                  </div>
                </div>
              )}

              {editing && (
                <button onClick={() => saveMutation.mutate(selected)} disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? <span className="spinner" /> : 'Save profile'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
