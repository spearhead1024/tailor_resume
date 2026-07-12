import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../lib/toast';

type Edu = { university: string; degree: string; duration: string; location: string };
type Work = { company_name: string; duration: string; location: string; legacy_role: string };
type BidProfile = {
  id: string; name: string; email: string; phone: string; location: string;
  address: string; zip_code: string; linkedin: string; github: string; portfolio: string;
  status: string; education_history: Edu[]; work_history: Work[]; bid_count: number;
};
type BidJob = {
  id: string; company: string; job_title: string; region: string;
  link: string; submitted_at: string; resume_id: string;
};
type JobDetail = BidJob & { description: string };
type StepState = 'active' | 'done' | 'todo';

async function downloadResumePdf(resumeId: string, profileName: string, toast: ReturnType<typeof useToast>): Promise<boolean> {
  const res = await api.raw.get(`/api/resumes/${resumeId}/pdf`, { responseType: 'blob' });
  const blob = res.data as Blob;
  const filename = `${(profileName || 'Resume').trim() || 'Resume'} resume.pdf`;
  const w = window as any;
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      toast(`Saved ${filename}`, 'success');
      return true;
    } catch (e: any) {
      if (e?.name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Downloaded ${filename}`, 'success');
  return true;
}

/* ----------------------------- Profile panel --------------------------- */

const CopyIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.55 }}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  const empty = !value?.trim();
  const copy = () => { if (!empty) { navigator.clipboard.writeText(value); toast(`Copied ${label.toLowerCase()}`, 'success'); } };
  return (
    <div onClick={copy} title={empty ? '' : 'Click to copy'}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
        padding: '0.5rem 0.65rem', borderRadius: 10,
        border: '1px solid var(--border, #2a3344)', background: 'var(--bg, rgba(255,255,255,0.02))',
        cursor: empty ? 'default' : 'pointer',
      }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="muted" style={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        <div style={{ fontSize: '0.8rem', wordBreak: 'break-word', color: empty ? 'var(--muted)' : 'var(--text)', whiteSpace: 'pre-wrap' }}>{value || '—'}</div>
      </div>
      {!empty && <span style={{ flex: '0 0 auto' }}><CopyIcon /></span>}
    </div>
  );
}

function ProfilePanel({ profile }: { profile: BidProfile }) {
  const eduValue = (profile.education_history || [])
    .map((e) => [e.university, [e.degree, e.duration].filter(Boolean).join(', ')].filter(Boolean).join(' – '))
    .join('\n');
  const work = profile.work_history || [];

  return (
    <div style={{ position: 'relative', minHeight: 0 }}>
      <div className="card" style={{ position: 'absolute', inset: 0, padding: '0.9rem', overflowY: 'auto' }}>
        <div style={{ marginBottom: 12 }}><strong>Profile</strong> <span className="muted">— click any field to copy</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <CopyField label="Full Name" value={profile.name} />
          <CopyField label="Email" value={profile.email} />
          <CopyField label="Location" value={profile.location} />
          <CopyField label="Phone" value={profile.phone} />
          <CopyField label="Address" value={profile.address} />
          <CopyField label="Zip Code" value={profile.zip_code} />
          <div style={{ gridColumn: '1 / -1' }}><CopyField label="LinkedIn" value={profile.linkedin} /></div>
          <div style={{ gridColumn: '1 / -1' }}><CopyField label="Portfolio" value={profile.portfolio} /></div>
          {profile.github?.trim() ? <div style={{ gridColumn: '1 / -1' }}><CopyField label="GitHub" value={profile.github} /></div> : null}
          {eduValue && <div style={{ gridColumn: '1 / -1' }}><CopyField label="Education" value={eduValue} /></div>}
          {work.length > 0 && (
            <div className="muted" style={{ gridColumn: '1 / -1', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>
              Work History ({work.length})
            </div>
          )}
          {work.map((w, i) => (
            <div key={i} style={{ gridColumn: '1 / -1' }}>
              <CopyField
                label={w.company_name || `Company ${i + 1}`}
                value={[w.legacy_role, w.duration, w.location].filter(Boolean).join(' · ')}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --------------------------- Resume preview ---------------------------- */

function ResumePreview({ resumeId, profileName }: { resumeId: string; profileName: string }) {
  const toast = useToast();
  const [pdfUrl, setPdfUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!resumeId) { setPdfUrl(''); setError(''); return; }
    let cancelled = false; let url = '';
    setLoading(true); setError('');
    api.raw.get(`/api/resumes/${resumeId}/pdf`, { responseType: 'blob' })
      .then((res) => { if (cancelled) return; url = URL.createObjectURL(res.data as Blob); setPdfUrl(url); })
      .catch(() => { if (!cancelled) setError('Preview failed to render — try Download.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [resumeId]);

  return (
    <div style={{ position: 'relative', minHeight: 0 }}>
      <div className="card" style={{ position: 'absolute', inset: 0, padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0.7rem 0.9rem', borderBottom: '1px solid var(--border, #2a3344)', flex: '0 0 auto' }}>
          <strong>Resume Preview</strong>
          {resumeId && <span style={{ fontSize: '0.7rem', color: '#16a34a', border: '1px solid #16a34a55', borderRadius: 6, padding: '1px 7px' }}>Generated</span>}
          <button className="secondary" style={{ marginLeft: 'auto' }}
            onClick={() => { if (!resumeId) { toast('Generate a resume first', 'error'); return; } downloadResumePdf(resumeId, profileName, toast); }}>
            ⭳ Download PDF
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, background: '#262626' }}>
          {!resumeId && (
            <div className="muted" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '2rem' }}>
              Generate a resume to preview it here.
            </div>
          )}
          {resumeId && loading && (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="spinner" /> Rendering…</div>
          )}
          {resumeId && !loading && error && (
            <div className="muted" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>{error}</div>
          )}
          {resumeId && !loading && !error && pdfUrl && (
            <iframe title="Resume preview" src={pdfUrl} style={{ width: '100%', height: '100%', border: 0 }} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Step badge ------------------------------ */

function StepBadge({ n, state }: { n: number; state: StepState }) {
  const bg = state === 'active' ? 'var(--accent, #2563eb)' : state === 'done' ? '#16a34a' : 'var(--border, #334155)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 26, height: 26, borderRadius: '50%', flex: '0 0 auto',
      fontSize: '0.78rem', fontWeight: 700, background: bg,
      color: state === 'todo' ? 'var(--muted)' : '#fff',
    }}>{state === 'done' ? '✓' : n}</span>
  );
}

/* ------------------------- One job, worked fully ----------------------- */

function BidJobView({ job, profile, onAdvance }: { job: BidJob; profile: BidProfile; onAdvance: () => void }) {
  const toast = useToast();

  const already = !!job.resume_id;
  const [promptCopied, setPromptCopied] = useState(already);
  const [resumeId, setResumeId] = useState(job.resume_id || '');
  const [jsonText, setJsonText] = useState('');
  const [downloaded, setDownloaded] = useState(false);
  const [busy, setBusy] = useState<'' | 'prompt' | 'gen' | 'dl' | 'apply' | 'report'>('');

  const [descOpen, setDescOpen] = useState(false);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [descLoading, setDescLoading] = useState(false);

  const generated = !!resumeId;
  const s1: StepState = generated ? 'done' : 'active';
  const s2: StepState = !generated ? 'todo' : downloaded ? 'done' : 'active';
  const s3: StepState = !downloaded ? 'todo' : 'active';

  const refresh = () => onAdvance();

  // Anti-cheat audit: log every button click server-side. Buttons are enabled,
  // so this is how we see who skipped steps. Fire-and-forget.
  const track = (action: string) => {
    api.post('/api/resumes/bid/track', {
      profile_id: profile.id, job_id: job.id, action,
      company: job.company, job_title: job.job_title,
    }).catch(() => {});
  };

  const viewDescription = async () => {
    setDescOpen(true);
    if (detail || descLoading) return;
    setDescLoading(true);
    try {
      const d = await api.get<JobDetail>(`/api/resumes/bid-job/${encodeURIComponent(job.id)}`);
      setDetail(d);
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Could not load description', 'error');
    } finally { setDescLoading(false); }
  };

  const copyPrompt = async () => {
    if (busy) return;
    setBusy('prompt');
    try {
      const res = await api.get<{ prompt: string }>(
        `/api/resumes/prompt?profile_id=${encodeURIComponent(profile.id)}&job_id=${encodeURIComponent(job.id)}`,
      );
      await navigator.clipboard.writeText(res.prompt);
      setPromptCopied(true);
      track('copy_prompt');
      toast('Prompt copied — paste it into ChatGPT / Claude / DeepSeek', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to copy prompt', 'error');
    } finally { setBusy(''); }
  };

  const generate = async () => {
    if (busy) return;
    const text = jsonText.trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.job_id && parsed.job_id !== job.id) {
        toast('This JSON was generated for a different job — copy the prompt for THIS job first.', 'error');
        return;
      }
    } catch {
      toast('That is not valid JSON — paste the full JSON the model returned.', 'error');
      return;
    }
    setBusy('gen');
    try {
      const res = await api.post<{ ok: boolean; saved_resume_id: string }>(
        '/api/resumes/generate-from-json', { json_text: text, profile_id: profile.id },
      );
      setResumeId(res.saved_resume_id);
      track('generate');
      toast('Resume generated', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to generate resume', 'error');
    } finally { setBusy(''); }
  };

  const download = async () => {
    if (busy) return;
    if (!resumeId) { toast('Generate a resume first', 'error'); return; }
    setBusy('dl');
    try {
      const ok = await downloadResumePdf(resumeId, profile.name, toast);
      if (ok) { setDownloaded(true); track('download'); }
    } catch (e: any) {
      const data = e?.response?.data;
      if (data instanceof Blob) toast('PDF still rendering — try again in a moment', 'info');
      else toast(data?.detail || 'Download failed', 'error');
    } finally { setBusy(''); }
  };

  const openLink = () => {
    const url = (job.link || '').trim();
    if (!url) { toast('This job has no link', 'info'); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
    track('open_link');
  };

  const markApplied = async () => {
    if (busy) return;
    track('mark_applied');
    if (!resumeId) { toast('Generate a resume before marking applied', 'error'); return; }
    setBusy('apply');
    try {
      await api.post(`/api/resumes/${resumeId}/apply`);
      toast(`Marked applied — ${job.company}`, 'success');
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to mark applied', 'error');
      setBusy('');
    }
  };

  const reportJob = async () => {
    if (busy) return;
    const reason = window.prompt(`Report this job — "${job.company} · ${job.job_title}".\nWhat's wrong? (e.g. link broken, posting closed, spam)`);
    if (reason === null) return;
    const trimmed = reason.trim();
    if (!trimmed) { toast('A reason is required', 'error'); return; }
    setBusy('report');
    try {
      await api.post(`/api/jobs/${job.id}/reports`, { reason: trimmed });
      track('report');
      toast('Job reported — it will be reviewed', 'success');
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to report job', 'error');
      setBusy('');
    }
  };

  const innerBox: CSSProperties = { border: '1px solid var(--border, #2a3344)', borderRadius: 12, padding: '0.85rem 0.95rem', marginTop: 12 };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.15fr) minmax(0,1fr)', gap: '1rem', alignItems: 'stretch' }}>
      {/* ---------- Column 1: workflow ---------- */}
      <div className="card" style={{ padding: '1rem 1.1rem' }}>
        {/* Job summary + JD */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{job.company || '—'}
              <span style={{ fontSize: '0.68rem', marginLeft: 8, background: 'var(--border,#334155)', borderRadius: 4, padding: '1px 6px' }}>{job.region}</span>
            </div>
            <div className="muted" style={{ fontSize: '0.82rem' }}>{job.job_title || '—'}</div>
          </div>
          <button className="secondary" onClick={viewDescription} style={{ flex: '0 0 auto' }}>View JD</button>
        </div>

        {/* Step 1 — Generate */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <StepBadge n={1} state={s1} /><strong>Generate Resume</strong>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button onClick={copyPrompt}>
            {busy === 'prompt' ? <span className="spinner" /> : (promptCopied ? 'Copy Prompt again' : 'Copy Prompt')}
          </button>
          <button onClick={generate}>
            {busy === 'gen' ? <span className="spinner" /> : 'Generate Resume'}
          </button>
        </div>
        <textarea rows={6} value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          placeholder="Paste the JSON the model returned…"
          style={{ width: '100%', marginTop: 8, fontFamily: 'monospace', fontSize: '0.82rem' }} />

        {/* Step 2 — Download */}
        <div style={innerBox}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <StepBadge n={2} state={s2} /><strong>Download</strong>
          </div>
          <div className="muted" style={{ fontSize: '0.8rem', marginLeft: 36, marginBottom: 10 }}>Download your generated resume or open the job link.</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button onClick={download}>{busy === 'dl' ? <span className="spinner" /> : '⭳ Download Resume'}</button>
            <button className="secondary" onClick={openLink}>↗ Open Job Link</button>
          </div>
        </div>

        {/* Step 3 — Finish */}
        <div style={innerBox}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <StepBadge n={3} state={s3} /><strong>Finish</strong>
          </div>
          <div className="muted" style={{ fontSize: '0.8rem', marginLeft: 36, marginBottom: 10 }}>Mark as applied or report this job.</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button onClick={markApplied} title="Mark this job as applied">
              {busy === 'apply' ? <span className="spinner" /> : 'Mark as Applied'}
            </button>
            <button className="danger" onClick={reportJob}>
              {busy === 'report' ? <span className="spinner" /> : 'Report Job'}
            </button>
          </div>
        </div>
      </div>

      {/* ---------- Column 2: preview ---------- */}
      <ResumePreview resumeId={resumeId} profileName={profile.name} />

      {/* ---------- Column 3: profile ---------- */}
      <ProfilePanel profile={profile} />

      {/* Description modal */}
      {descOpen && (
        <div onClick={() => setDescOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '2rem' }}>
          <div className="card" onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 760, width: '100%', maxHeight: '80vh', overflowY: 'auto', padding: '1.2rem 1.4rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong>{job.company} · {job.job_title}</strong>
              <button className="ghost" onClick={() => setDescOpen(false)}>✕</button>
            </div>
            {descLoading ? <div><span className="spinner" /> Loading…</div>
              : <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.88rem', lineHeight: 1.5 }}>{detail?.description || 'No description.'}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- Page ---------------------------------- */

export default function Bid() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['bid', 'profiles'],
    queryFn: () => api.get<{ role: string; profiles: BidProfile[] }>('/api/resumes/bid/profiles'),
  });
  const profiles: BidProfile[] = data?.profiles || [];
  const [profileId, setProfileId] = useState('');

  useEffect(() => {
    if (profiles.length === 0) return;
    if (!profiles.find((p) => p.id === profileId)) {
      const firstWithWork = profiles.find((p) => p.bid_count > 0 && p.status !== 'restricted');
      const firstActive = profiles.find((p) => p.status !== 'restricted');
      setProfileId((firstWithWork || firstActive || profiles[0]).id);
    }
  }, [profiles, profileId]);

  const profile = profiles.find((p) => p.id === profileId);
  const totalToBid = useMemo(() => profiles.reduce((s, p) => s + (p.bid_count || 0), 0), [profiles]);

  const { data: queue = [], isLoading: queueLoading } = useQuery({
    queryKey: ['bid', 'queue', profileId],
    queryFn: () => api.get<BidJob[]>(`/api/resumes/bid?profile_id=${encodeURIComponent(profileId)}`),
    enabled: !!profileId,
  });
  const currentJob = queue[0];

  const advance = () => {
    qc.invalidateQueries({ queryKey: ['bid', 'queue', profileId] });
    qc.invalidateQueries({ queryKey: ['bid', 'profiles'] });
    qc.invalidateQueries({ queryKey: ['metrics'] });
  };

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;
  if (profiles.length === 0) {
    return (
      <div>
        <h1>Bid</h1>
        <div className="card"><span className="muted">No accessible profiles. Ask an admin to assign one to your account.</span></div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0 }}>Bid</h1>
          <div className="muted" style={{ fontSize: '0.88rem' }}>Generate and download a tailored resume for this job.</div>
        </div>
        <div className="card" style={{ padding: '0.45rem 0.8rem', fontSize: '0.85rem' }}>
          Total to do across all profiles: <strong style={{ color: 'var(--accent,#2563eb)' }}>{totalToBid}</strong>
        </div>
      </div>

      <div style={{ margin: '1rem 0' }}>
        <div className="muted" style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Select profile</div>
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)} style={{ width: '100%' }}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {`${p.name} · ${p.status === 'restricted' ? 'Restricted' : 'Active'} · ${p.bid_count} to bid`}
            </option>
          ))}
        </select>
      </div>

      {queueLoading ? (
        <div><span className="spinner" /> Loading jobs…</div>
      ) : !currentJob ? (
        <div className="card"><span className="muted">Nothing to bid for this profile right now. 🎉</span></div>
      ) : (
        <BidJobView key={currentJob.id} job={currentJob} profile={profile!} onAdvance={advance} />
      )}
    </div>
  );
}
