import { useState, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import SourceBadge from '../lib/SourceBadge';
import { CONTRACTS, CURRENCIES, PERIODS, contractText, salaryText } from '../lib/profile-terms';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

function ReadValue({ value }: { value: string }) {
  return (
    <div style={{ padding: '0.4rem 0', minHeight: '1.5rem', whiteSpace: 'pre-wrap', userSelect: 'text' }}>
      {value || <span className="muted">—</span>}
    </div>
  );
}

const BLANK_PROFILE = {
  id: '',
  name: '',
  email: '',
  phone: '',
  location: '',
  address: '',
  zip_code: '',
  linkedin: '',
  github: '',
  portfolio: '',
  region: 'US',
  tech_stacks: [] as string[],
  work_history: [] as any[],
  education_history: [] as any[],
  resume_template: 'spear-1',
  status: 'active',
  total_years_of_experience: 0,
  summary_seed: '',
  // Who they are on paper (DOB) and on what terms they can be hired. A new profile must carry these
  // keys or a profile created from this page starts out with whatever the server defaults to rather
  // than what the form is showing.
  date_of_birth: '',
  contract_types: [] as string[],
  b2b_country: '',
  expected_salary: { min: 0, max: 0, currency: 'USD', period: 'year' },
  generation_settings: { summary_char_count: 650, skills_count: 85, bullet_counts: [] as number[] },
};


export default function Profiles() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = !!user?.is_admin;

  const [selected, setSelected]     = useState<any | null>(null);
  const [editing, setEditing]       = useState(false);
  const [bulletCounts, setBulletCounts] = useState<number[]>([]);

  // Raw textarea strings — let the user type freely; parse on change
  const [workHistoryRaw, setWorkHistoryRaw] = useState('[]');
  const [workHistoryError, setWorkHistoryError] = useState(false);
  const [eduHistoryRaw, setEduHistoryRaw]   = useState('[]');
  const [eduHistoryError, setEduHistoryError] = useState(false);
  // Comma-separated raw string so commas type naturally; parsed to array on save.
  const [techStacksRaw, setTechStacksRaw]   = useState('');

  // File queued for upload when creating a new profile (uploaded after save returns the id)
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<any[]>('/api/profiles'),
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.post(`/api/profiles/${id}/upload-resume`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setSelected((prev: any) => ({ ...prev, ...data }));
    },
  });

  const [dlBusy, setDlBusy] = useState(false);
  // Download a profile's DOCX template (admin-only endpoint). Fetch as a blob so
  // the Bearer token is sent — a plain <a href> would navigate without it → 401.
  async function downloadDocx(id: string, filename: string) {
    if (dlBusy) return;
    setDlBusy(true);
    try {
      const res = await api.raw.get(`/api/profiles/${id}/resume`, { responseType: 'blob' });
      const blob = res.data as Blob;
      const name = filename || 'resume.docx';
      const w = window as any;
      // Preferred path: the File System Access API gives a real Save dialog and
      // never races an object-URL revoke.
      if (typeof w.showSaveFilePicker === 'function') {
        try {
          const handle = await w.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: 'Word document', accept: { [DOCX_MIME]: ['.docx'] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return;
        } catch (e: any) {
          if (e?.name === 'AbortError') return;   // user cancelled — not an error
          // otherwise fall through to the anchor method
        }
      }
      // Fallback: anchor + object URL. Revoke LATE (4s) — revoking too early is
      // what made this download "sometimes work, sometimes not": on a slower
      // machine the browser hadn't finished reading the blob before the URL was
      // freed, so the download silently failed.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      toast('Failed to download résumé DOCX', 'error');
    } finally {
      setDlBusy(false);
    }
  }

  const saveMutation = useMutation({
    mutationFn: (p: any) => p.id
      ? api.patch(`/api/profiles/${p.id}`, { payload: p })
      : api.post('/api/profiles', { payload: p }),
    onSuccess: (data: any, variables: any) => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setSelected(data);
      setEditing(false);
      // If a file was queued (new profile flow), upload it now that we have an id
      if (!variables.id && pendingFile) {
        uploadMutation.mutate({ id: data.id, file: pendingFile });
        setPendingFile(null);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/profiles/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['profiles'] }); setSelected(null); },
  });

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  function enterEditMode(p: any) {
    const wh = p.work_history || [];
    const eh = p.education_history || [];
    setWorkHistoryRaw(JSON.stringify(wh, null, 2));
    setWorkHistoryError(false);
    setEduHistoryRaw(JSON.stringify(eh, null, 2));
    setEduHistoryError(false);
    setBulletCounts((p.generation_settings?.bullet_counts || []).map(Number));
    setTechStacksRaw(((p.tech_stacks as string[]) || []).join(', '));
    setPendingFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setSelected({ ...p });
    setEditing(true);
  }

  function handleSelect(p: any) {
    setSelected({ ...p });
    setBulletCounts((p.generation_settings?.bullet_counts || []).map(Number));
    setEditing(false);
  }

  function handleNew()  { enterEditMode({ ...BLANK_PROFILE }); }
  function handleEdit() { enterEditMode(selected); }

  function handleCancel() {
    if (!selected?.id) {
      setSelected(null);
      setEditing(false);
    } else {
      const original = profiles.find((p: any) => p.id === selected.id);
      if (original) handleSelect(original);
      else setEditing(false);
    }
  }

  function handleWorkHistoryChange(raw: string) {
    setWorkHistoryRaw(raw);
    try {
      const wh = JSON.parse(raw);
      setWorkHistoryError(false);
      setSelected((prev: any) => ({ ...prev, work_history: wh }));
      setBulletCounts((prev) => {
        const next = [...prev];
        while (next.length < wh.length) next.push(10);
        return next.slice(0, wh.length);
      });
    } catch {
      setWorkHistoryError(true);
    }
  }

  function handleEduHistoryChange(raw: string) {
    setEduHistoryRaw(raw);
    try {
      const eh = JSON.parse(raw);
      setEduHistoryError(false);
      setSelected((prev: any) => ({ ...prev, education_history: eh }));
    } catch {
      setEduHistoryError(true);
    }
  }

  function handleSave() {
    if (workHistoryError || eduHistoryError) return;
    const payload = {
      ...selected,
      tech_stacks: techStacksRaw.split(',').map((s) => s.trim()).filter(Boolean),
      total_years_of_experience: Number(selected.total_years_of_experience) || 0,
      summary_seed: selected.summary_seed || '',
      generation_settings: {
        summary_char_count: Number(selected.generation_settings?.summary_char_count) || 650,
        skills_count: Number(selected.generation_settings?.skills_count) || 85,
        bullet_counts: bulletCounts,
        // VPS1 prompt fields — drive the ChatGPT prompt's tech-skill target and
        // the default per-company bullet count.
        tech_skills_target: Number(selected.generation_settings?.tech_skills_target) || 70,
        bullets_per_company_default: Number(selected.generation_settings?.bullets_per_company_default) || 5,
      },
      // Editable FIXED WORK HISTORY detected from the uploaded DOCX.
      detected_work_history: (selected.detected_work_history || []).map((d: any) => ({
        company_name: String(d.company_name || '').trim(),
        role_title: String(d.role_title || '').trim(),
        duration: String(d.duration || '').trim(),
        location: String(d.location || '').trim(),
        bullets: Number(d.bullets) || 5,
      })).filter((d: any) => d.company_name),
    };
    saveMutation.mutate(payload);
  }

  const workHistory: any[] = selected?.work_history || [];
  const isSaving = saveMutation.isPending || uploadMutation.isPending;

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
            {profiles.map((p: any) => (
              <div key={p.id} onClick={() => handleSelect(p)} style={{
                padding: '0.7rem 1rem', cursor: 'pointer',
                borderBottom: '1px solid var(--border)',
                background: selected?.id === p.id ? 'var(--panel-2)' : '',
              }}>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{p.name || '(unnamed)'}</span>
                  {p.source === 'VPS_1' && <SourceBadge source={p.source} />}
                </div>
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
                <h2 style={{ margin: 0 }}>
                  {editing ? (selected.id ? 'Edit profile' : 'New profile') : selected.name}
                </h2>
                {!editing && selected.id && selected.source !== 'VPS_1' && (
                  <span className={`pill ${selected.status === 'restricted' ? 'rejected' : 'approved'}`}>
                    {(selected.status || 'active').toUpperCase()}
                  </span>
                )}
                {selected.source === 'VPS_1' && <SourceBadge source={selected.source} />}
                <div style={{ flex: 1 }} />
                {/* A VPS_1 profile IS editable here: VPS_1 only sends a few fields, so an admin fills
                    the rest in on this side and the edit is kept even when the hourly mirror refreshes.
                    Delete stays hidden though — the row belongs to VPS_1 and would just come back. */}
                {isAdmin && !editing && (
                  <>
                    <button onClick={handleEdit} className="secondary">Edit</button>
                    {selected.id && selected.source !== 'VPS_1' && (
                      <button className="danger" style={{ marginLeft: 6 }}
                        onClick={() => { if (confirm('Delete profile?')) deleteMutation.mutate(selected.id); }}>
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* ── Personal info ── */}
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
                <Field label="Address">
                  {editing
                    ? <input value={selected.address || ''} onChange={(e) => setSelected({ ...selected, address: e.target.value })} />
                    : <ReadValue value={selected.address} />}
                </Field>
                <Field label="Zip code">
                  {editing
                    ? <input value={selected.zip_code || ''} onChange={(e) => setSelected({ ...selected, zip_code: e.target.value })} />
                    : <ReadValue value={selected.zip_code} />}
                </Field>
              </div>
              <div className="row">
                <Field label="LinkedIn">
                  {editing
                    ? <input value={selected.linkedin || ''} onChange={(e) => setSelected({ ...selected, linkedin: e.target.value })} />
                    : <ReadValue value={selected.linkedin} />}
                </Field>
                <Field label="GitHub">
                  {editing
                    ? <input value={selected.github || ''} onChange={(e) => setSelected({ ...selected, github: e.target.value })} />
                    : <ReadValue value={selected.github} />}
                </Field>
                <Field label="Portfolio">
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
                <Field label="Region">
                  {editing
                    ? (
                      <select value={selected.region || 'US'} onChange={(e) => setSelected({ ...selected, region: e.target.value })}>
                        <option value="US">US</option>
                        <option value="EU">EU</option>
                        <option value="LATAM">LATAM</option>
                        <option value="ANY">ANY</option>
                      </select>
                    )
                    : <ReadValue value={selected.region || 'US'} />}
                </Field>
              </div>
              <div className="row">
                <Field label="Status">
                  {editing
                    ? (
                      <select value={selected.status || 'active'} onChange={(e) => setSelected({ ...selected, status: e.target.value })}>
                        <option value="active">Active</option>
                        <option value="restricted">Restricted</option>
                      </select>
                    )
                    : <ReadValue value={(selected.status || 'active').toUpperCase()} />}
                </Field>
                <Field label="Date of birth">
                  {editing
                    ? <input type="date" value={selected.date_of_birth || ''}
                        onChange={(e) => setSelected({ ...selected, date_of_birth: e.target.value })} />
                    : <ReadValue value={selected.date_of_birth} />}
                </Field>
              </div>

              {/* ── How they can be engaged ── */}
              <div className="row">
                <Field label="Can work as">
                  {editing ? (
                    <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '6px 0', flexWrap: 'wrap' }}>
                      {CONTRACTS.map((c) => (
                        <label key={c.id} style={{ display: 'flex', gap: 5, alignItems: 'center', fontWeight: 400, cursor: 'pointer' }}>
                          <input type="checkbox" checked={(selected.contract_types || []).includes(c.id)}
                            onChange={(e) => {
                              const cur: string[] = selected.contract_types || [];
                              const next = e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id);
                              setSelected({
                                ...selected,
                                contract_types: next,
                                // drop the country when B2B goes away, or it lingers where nothing shows it
                                b2b_country: next.includes('b2b') ? (selected.b2b_country || '') : '',
                              });
                            }} />
                          {c.label}
                        </label>
                      ))}
                    </div>
                  ) : <ReadValue value={contractText(selected.contract_types, selected.b2b_country)} />}
                </Field>
                {(selected.contract_types || []).includes('b2b') && (
                  <Field label="B2B country">
                    {editing
                      ? <input placeholder="Romania" value={selected.b2b_country || ''}
                          onChange={(e) => setSelected({ ...selected, b2b_country: e.target.value })} />
                      : <ReadValue value={selected.b2b_country} />}
                  </Field>
                )}
              </div>

              {/* ── What they expect to be paid ── */}
              <div className="row">
                <Field label="Expected salary (min)">
                  {editing
                    ? <input type="number" min={0} value={selected.expected_salary?.min ?? 0}
                        onChange={(e) => setSelected({ ...selected, expected_salary: { ...(selected.expected_salary || {}), min: Number(e.target.value) } })} />
                    : <ReadValue value={salaryText(selected.expected_salary)} />}
                </Field>
                {editing && (
                  <>
                    <Field label="Max">
                      <input type="number" min={0} value={selected.expected_salary?.max ?? 0}
                        onChange={(e) => setSelected({ ...selected, expected_salary: { ...(selected.expected_salary || {}), max: Number(e.target.value) } })} />
                    </Field>
                    <Field label="Currency">
                      <select value={selected.expected_salary?.currency || 'USD'}
                        onChange={(e) => setSelected({ ...selected, expected_salary: { ...(selected.expected_salary || {}), currency: e.target.value } })}>
                        {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </Field>
                    <Field label="Per">
                      <select value={selected.expected_salary?.period || 'year'}
                        onChange={(e) => setSelected({ ...selected, expected_salary: { ...(selected.expected_salary || {}), period: e.target.value } })}>
                        {PERIODS.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </Field>
                  </>
                )}
              </div>

              {/* ── Work history ── */}
              <Field label="Work history (JSON)">
                {editing ? (
                  <>
                    <textarea rows={6} value={workHistoryRaw}
                      onChange={(e) => handleWorkHistoryChange(e.target.value)}
                      style={{ borderColor: workHistoryError ? 'var(--danger,#ef4444)' : undefined }} />
                    {workHistoryError && <span style={{ fontSize: '0.8rem', color: 'var(--danger,#ef4444)' }}>Invalid JSON</span>}
                  </>
                ) : (
                  <textarea rows={6} readOnly value={JSON.stringify(selected.work_history || [], null, 2)} style={{ userSelect: 'text' }} />
                )}
              </Field>

              {/* ── Education history ── */}
              <Field label="Education history (JSON)">
                {editing ? (
                  <>
                    <textarea rows={4} value={eduHistoryRaw}
                      onChange={(e) => handleEduHistoryChange(e.target.value)}
                      style={{ borderColor: eduHistoryError ? 'var(--danger,#ef4444)' : undefined }} />
                    {eduHistoryError && <span style={{ fontSize: '0.8rem', color: 'var(--danger,#ef4444)' }}>Invalid JSON</span>}
                  </>
                ) : (
                  <textarea rows={4} readOnly value={JSON.stringify(selected.education_history || [], null, 2)} style={{ userSelect: 'text' }} />
                )}
              </Field>

              {/* ── Tech stacks for job matching (admin) ── */}
              {isAdmin && (
                <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Tech stacks (job matching)</div>
                  {editing ? (
                    <Field label="Main skills — comma separated. Leave empty for All-Stack (matches every job).">
                      <input
                        value={techStacksRaw}
                        onChange={(e) => setTechStacksRaw(e.target.value)}
                        placeholder="e.g. Java, Spring Boot" />
                      <div className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>
                        A job is assigned to this profile when any of these skills appears as a
                        whole word in its description (case-insensitive; “Java” ≠ “JavaScript”).
                        These skills are also added to every resume this profile generates.
                      </div>
                    </Field>
                  ) : selected.id ? (
                    <Field label="Tech stacks">
                      <ReadValue value={((selected.tech_stacks as string[]) || []).length
                        ? (selected.tech_stacks as string[]).join(', ')
                        : 'All-Stack (matches every job)'} />
                    </Field>
                  ) : null}
                </div>
              )}

              {/* ── Generation settings (admin) ── */}
              {isAdmin && (
                <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Generation settings</div>

                  {editing ? (
                    <>
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
                      <Field label="Summary char count">
                        <input type="number" min={200} max={2000}
                          value={selected.generation_settings?.summary_char_count || 650}
                          onChange={(e) => setSelected({ ...selected, generation_settings: { ...selected.generation_settings, summary_char_count: Number(e.target.value) } })} />
                      </Field>

                      {/* VPS1 prompt controls: the ChatGPT prompt asks for tech_skills_target±5
                          unique skills, and EXACTLY N bullets per company (default below, or the
                          per-company value in the FIXED WORK HISTORY table). */}
                      <div className="row">
                        <Field label="Tech skills target (prompt)">
                          <input type="number" min={10} max={200}
                            value={selected.generation_settings?.tech_skills_target ?? 70}
                            onChange={(e) => setSelected({ ...selected, generation_settings: { ...selected.generation_settings, tech_skills_target: Number(e.target.value) } })} />
                        </Field>
                        <Field label="Bullets / company (default)">
                          <input type="number" min={1} max={20}
                            value={selected.generation_settings?.bullets_per_company_default ?? 5}
                            onChange={(e) => setSelected({ ...selected, generation_settings: { ...selected.generation_settings, bullets_per_company_default: Number(e.target.value) } })} />
                        </Field>
                      </div>

                      {/* FIXED WORK HISTORY — auto-detected from the uploaded DOCX; seeds the prompt.
                          Editable: company, duration, and the exact bullet count per company. */}
                      <Field label="Fixed work history (detected from DOCX — seeds the ChatGPT prompt)">
                        {(selected.detected_work_history || []).length === 0 ? (
                          <span className="muted" style={{ fontSize: '0.85rem' }}>
                            Upload a DOCX resume above — the companies, durations, and per-company bullet
                            counts are detected automatically and can be edited here.
                          </span>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {(selected.detected_work_history as any[]).map((d: any, i: number) => (
                              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <input style={{ flex: 2 }} placeholder="Company"
                                  value={d.company_name || ''}
                                  onChange={(e) => {
                                    const next = [...(selected.detected_work_history || [])];
                                    next[i] = { ...next[i], company_name: e.target.value };
                                    setSelected({ ...selected, detected_work_history: next });
                                  }} />
                                <input style={{ flex: 2 }} placeholder="Duration"
                                  value={d.duration || ''}
                                  onChange={(e) => {
                                    const next = [...(selected.detected_work_history || [])];
                                    next[i] = { ...next[i], duration: e.target.value };
                                    setSelected({ ...selected, detected_work_history: next });
                                  }} />
                                <input type="number" min={1} max={20} style={{ width: 64 }} title="Bullets"
                                  value={d.bullets ?? 5}
                                  onChange={(e) => {
                                    const next = [...(selected.detected_work_history || [])];
                                    next[i] = { ...next[i], bullets: Number(e.target.value) };
                                    setSelected({ ...selected, detected_work_history: next });
                                  }} />
                                <button type="button" className="ghost danger" title="Remove"
                                  onClick={() => {
                                    const next = (selected.detected_work_history || []).filter((_: any, j: number) => j !== i);
                                    setSelected({ ...selected, detected_work_history: next });
                                  }}>✕</button>
                              </div>
                            ))}
                            <button type="button" className="secondary" style={{ alignSelf: 'flex-start' }}
                              onClick={() => setSelected({
                                ...selected,
                                detected_work_history: [
                                  ...(selected.detected_work_history || []),
                                  { company_name: '', role_title: '', duration: '', location: '', bullets: Number(selected.generation_settings?.bullets_per_company_default) || 5 },
                                ],
                              })}>+ Add company</button>
                          </div>
                        )}
                      </Field>

                      <Field label="Summary seed (optional — extra context for AI summary generation)">
                        <textarea rows={3}
                          value={selected.summary_seed || ''}
                          onChange={(e) => setSelected({ ...selected, summary_seed: e.target.value })}
                          placeholder="e.g. Focus on blockchain and DeFi expertise, highlight leadership roles…" />
                      </Field>

                      {/* Bullet count per company — always visible; shows inputs once work history is pasted */}
                      <Field label="Bullet count per company (most recent first)">
                        {workHistory.length === 0 ? (
                          <span className="muted" style={{ fontSize: '0.85rem' }}>
                            Appears automatically after you paste valid work history JSON above.
                          </span>
                        ) : (
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
                        )}
                      </Field>
                    </>
                  ) : selected.id ? (
                    <>
                      <div className="row">
                        <Field label="Total years of experience"><ReadValue value={String(selected.total_years_of_experience ?? 0)} /></Field>
                        <Field label="Skills count"><ReadValue value={String(selected.generation_settings?.skills_count ?? 85)} /></Field>
                      </div>
                      <Field label="Summary char count">
                        <ReadValue value={String(selected.generation_settings?.summary_char_count || 650)} />
                      </Field>
                      <div className="row">
                        <Field label="Tech skills target"><ReadValue value={String(selected.generation_settings?.tech_skills_target ?? 70)} /></Field>
                        <Field label="Bullets / company (default)"><ReadValue value={String(selected.generation_settings?.bullets_per_company_default ?? 5)} /></Field>
                      </div>
                      {(selected.detected_work_history || []).length > 0 && (
                        <Field label="Fixed work history (prompt)">
                          <ReadValue value={(selected.detected_work_history as any[]).map((d: any) => `${d.company_name}${d.duration ? ` · ${d.duration}` : ''} → ${d.bullets} bullets`).join('\n')} />
                        </Field>
                      )}
                      {(selected.generation_settings?.bullet_counts || []).length > 0 && (
                        <Field label="Bullet counts per company (legacy)">
                          <ReadValue value={(selected.generation_settings.bullet_counts as number[]).join(', ')} />
                        </Field>
                      )}
                      {selected.summary_seed && (
                        <Field label="Summary seed"><ReadValue value={selected.summary_seed} /></Field>
                      )}
                    </>
                  ) : null}
                </div>
              )}

              {/* ── Autofill answers the extension learned for this profile (admin) ── */}
              {isAdmin && selected.id && <LearnedAnswers profileId={selected.id} />}

              {/* ── Uploaded DOCX template (admin) ── */}
              {isAdmin && (
                <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                  <Field label="Uploaded resume DOCX template">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {/* Show current filename + admin-only download */}
                      {(selected.uploaded_resume_filename || selected.uploaded_resume?.filename) && (
                        <>
                          <span className="muted">
                            {selected.uploaded_resume_filename || selected.uploaded_resume?.filename}
                          </span>
                          {selected.id && (
                            <button type="button" className="secondary" disabled={dlBusy}
                              style={{ fontSize: '0.8rem', padding: '2px 10px' }}
                              onClick={() => downloadDocx(selected.id, selected.uploaded_resume_filename || selected.uploaded_resume?.filename || 'resume.docx')}>
                              {dlBusy ? '…' : '⬇ Download'}
                            </button>
                          )}
                        </>
                      )}

                      {editing && (
                        <>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".docx"
                            style={{ maxWidth: 300 }}
                            onChange={(e) => {
                              const f = e.target.files?.[0] || null;
                              if (!f) return;
                              if (selected.id) {
                                // Existing profile — upload immediately
                                uploadMutation.mutate({ id: selected.id, file: f });
                              } else {
                                // New profile — queue; will upload after save
                                setPendingFile(f);
                              }
                            }}
                          />
                          {!selected.id && pendingFile && (
                            <span className="muted" style={{ fontSize: '0.82rem' }}>
                              "{pendingFile.name}" — will upload after save
                            </span>
                          )}
                          {uploadMutation.isPending && <span className="spinner" />}
                        </>
                      )}

                      {/* View mode: show picker only for existing profiles */}
                      {!editing && selected.id && (
                        <input type="file" accept=".docx" style={{ maxWidth: 300 }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) uploadMutation.mutate({ id: selected.id, file: f });
                          }} />
                      )}
                      {!editing && uploadMutation.isPending && <span className="spinner" />}

                      {!selected.id && !editing && (
                        <span className="muted" style={{ fontSize: '0.85rem' }}>(none)</span>
                      )}
                    </div>
                  </Field>
                </div>
              )}

              {/* ── Save / Cancel ── */}
              {editing && (
                <div style={{ marginTop: '1rem', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={handleSave} disabled={isSaving || workHistoryError || eduHistoryError}>
                    {isSaving ? <span className="spinner" /> : 'Save profile'}
                  </button>
                  <button className="secondary" onClick={handleCancel} disabled={isSaving}>Cancel</button>
                  {!selected.id && pendingFile && (
                    <span className="muted" style={{ fontSize: '0.82rem' }}>
                      Profile + DOCX will be saved together.
                    </span>
                  )}
                </div>
              )}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}


/* ---- Autofill answers learned by the extension ("Remember answers"), per profile ---- */
type LearnedAnswer = { question_key: string; question: string; answer: string; updated_by_username: string; updated_at: string };

function LearnedAnswers({ profileId }: { profileId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<{ key: string; value: string } | null>(null);
  const qk = ['autofill-answers', profileId];
  const { data = [], isLoading } = useQuery({
    queryKey: qk,
    queryFn: () => api.get<LearnedAnswer[]>(`/api/autofill/answers?profile_id=${encodeURIComponent(profileId)}`),
    enabled: open,
  });
  const save = async (key: string, answer: string) => {
    try {
      await api.patch('/api/autofill/answers', { profile_id: profileId, question_key: key, answer });
      setEdit(null); qc.invalidateQueries({ queryKey: qk });
    } catch (e: any) { toast(e?.response?.data?.detail || 'Save failed', 'error'); }
  };
  const remove = async (a: LearnedAnswer) => {
    if (!window.confirm(`Forget the answer to "${a.question}"?`)) return;
    try {
      await api.delete(`/api/autofill/answers?profile_id=${encodeURIComponent(profileId)}&question_key=${encodeURIComponent(a.question_key)}`);
      qc.invalidateQueries({ queryKey: qk });
    } catch (e: any) { toast(e?.response?.data?.detail || 'Delete failed', 'error'); }
  };
  return (
    <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
      <button type="button" className="ghost" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Autofill answers learned by the extension
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {isLoading ? <span className="spinner" /> : data.length === 0 ? (
            <div className="muted" style={{ fontSize: '0.85rem' }}>
              Nothing learned yet — bidders teach the extension by filling a question by hand and clicking <strong>Remember</strong> in the side panel.
            </div>
          ) : (
            <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
              <thead><tr className="muted" style={{ textAlign: 'left' }}><th style={{ padding: '4px 6px' }}>Question</th><th style={{ padding: '4px 6px' }}>Answer</th><th style={{ padding: '4px 6px' }}>By</th><th /></tr></thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.question_key} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px', maxWidth: 360 }}>{a.question}</td>
                    <td style={{ padding: '6px', minWidth: 160 }}>
                      {edit?.key === a.question_key ? (
                        <input autoFocus value={edit.value} onChange={(e) => setEdit({ key: a.question_key, value: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter' && edit.value.trim()) save(a.question_key, edit.value.trim()); if (e.key === 'Escape') setEdit(null); }} />
                      ) : a.answer}
                    </td>
                    <td className="muted" style={{ padding: '6px', whiteSpace: 'nowrap' }}>{a.updated_by_username}</td>
                    <td style={{ padding: '6px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {edit?.key === a.question_key ? (
                        <>
                          <button type="button" style={{ padding: '2px 10px', fontSize: '0.8rem' }} disabled={!edit.value.trim()} onClick={() => save(a.question_key, edit.value.trim())}>Save</button>{' '}
                          <button type="button" className="ghost" style={{ padding: '2px 10px', fontSize: '0.8rem' }} onClick={() => setEdit(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="secondary" style={{ padding: '2px 10px', fontSize: '0.8rem' }} onClick={() => setEdit({ key: a.question_key, value: a.answer })}>Edit</button>{' '}
                          <button type="button" className="ghost" style={{ padding: '2px 10px', fontSize: '0.8rem' }} onClick={() => remove(a)}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
