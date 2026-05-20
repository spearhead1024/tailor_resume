import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { copyText } from '../lib/clipboard';
import { useToast } from '../lib/toast';

type Profile = {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedin?: string;
  portfolio?: string;
  education_history?: Array<{ university?: string; degree?: string; duration?: string; location?: string }>;
  work_history?: Array<{ company_name?: string; duration?: string; location?: string; bullets?: string[] }>;
  [k: string]: any;
};

type SavedResume = {
  saved_resume_id: string;
  profile_id: string;
  job_id: string;
  job_company: string;
  job_title: string;
  job_link: string;
  job_description: string;
  resume: any;
  application_answers?: Array<{ question: string; answer: string }>;
  created_at: string;
  applied_status?: string;
  applied_at?: string;
  [k: string]: any;
};

type AppliedFilter = 'pending' | 'applied' | 'all';

// ─── Click-to-copy chip ──────────────────────────────────────────────────
function CopyChip({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const empty = !value;

  const handleClick = async () => {
    if (empty) return;
    const ok = await copyText(value);
    if (ok) {
      setCopied(true);
      toast(`Copied: ${label}`, 'success');
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      toast('Copy failed — select & copy manually', 'error');
    }
  };

  return (
    <div className={`copy-chip ${copied ? 'copied' : ''}`}
         onClick={handleClick}
         style={{ opacity: empty ? 0.45 : 1, cursor: empty ? 'default' : 'pointer' }}
         title={empty ? '' : 'Click to copy'}>
      <div className="copy-chip-label">
        {label} {copied && <span style={{ color: 'var(--success)' }}>✓ COPIED</span>}
      </div>
      <div className="copy-chip-value">{value || <span className="muted">—</span>}</div>
    </div>
  );
}

// ─── Answer block (click-to-copy) ────────────────────────────────────────
function AnswerCard({ question, answer, idx }: { question: string; answer: string; idx: number }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    if (!answer) return;
    const ok = await copyText(answer);
    if (ok) {
      setCopied(true);
      toast(`Copied answer Q${idx + 1}`, 'success');
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      toast('Copy failed', 'error');
    }
  };

  return (
    <div style={{ marginBottom: '0.9rem' }}>
      <div style={{ fontSize: '0.86rem', fontWeight: 600, marginBottom: 5, color: 'var(--text)' }}>
        Q{idx + 1}. {question}
      </div>
      <div onClick={handleClick}
        style={{
          cursor: answer ? 'pointer' : 'default',
          background: copied ? 'var(--success-bg)' : 'var(--panel-2)',
          border: `1px solid ${copied ? 'var(--success)' : 'var(--border-soft)'}`,
          borderRadius: 9,
          padding: '0.75rem 0.9rem',
          fontSize: '0.88rem',
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          transition: 'all 0.15s',
        }}
        title={answer ? 'Click to copy' : ''}>
        {answer || <span className="muted">No answer.</span>}
        {copied && (
          <div style={{ fontSize: '0.7rem', color: 'var(--success)', marginTop: 6, fontWeight: 600 }}>
            ✓ COPIED TO CLIPBOARD
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Resume card ─────────────────────────────────────────────────────────
function ResumeCard({
  resume, pdfUrl, pdfLoading, pdfError, onDownload, onMarkApplied, onRevert,
}: {
  resume: SavedResume;
  pdfUrl: string;
  pdfLoading: boolean;
  pdfError: string;
  onDownload: () => void;
  onMarkApplied: () => void;
  onRevert: () => void;
}) {
  const toast = useToast();
  const [copiedLink, setCopiedLink] = useState(false);
  const isApplied = resume.applied_status === 'applied';
  const answers = resume.application_answers || [];

  const copyLink = async () => {
    if (!resume.job_link) return;
    const ok = await copyText(resume.job_link);
    if (ok) {
      setCopiedLink(true);
      toast('Job link copied', 'success');
      window.setTimeout(() => setCopiedLink(false), 1500);
    } else {
      toast('Copy failed', 'error');
    }
  };

  return (
    <div className="card" style={{
      padding: '1.5rem 1.6rem',
      borderLeft: `4px solid ${isApplied ? 'var(--success)' : 'var(--warning)'}`,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: '1.25rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: '0.72rem', color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '0.08em',
            fontWeight: 700, marginBottom: 6,
          }}>
            {resume.job_company || 'Unknown company'}
          </div>
          <h2 style={{ margin: 0, fontSize: '1.5rem', letterSpacing: '-0.01em', wordWrap: 'break-word' }}>
            {resume.job_link ? (
              <a href={resume.job_link} target="_blank" rel="noreferrer">
                {resume.job_title || 'Open posting'}
              </a>
            ) : (resume.job_title || '—')}
          </h2>
          <div style={{ fontSize: '0.82rem', color: 'var(--muted)', marginTop: 8 }}>
            Generated {(resume.created_at || '').slice(0, 10) || '—'}
            {isApplied && resume.applied_at && (
              <> · <span style={{ color: 'var(--success)' }}>
                Applied {resume.applied_at.slice(0, 10)}
              </span></>
            )}
          </div>
        </div>
        <span className={`pill ${isApplied ? 'approved' : 'pending'}`}>
          {isApplied ? 'Applied' : 'Pending'}
        </span>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        <button onClick={onDownload} disabled={pdfLoading || !pdfUrl}>
          {pdfLoading ? <><span className="spinner" /> Rendering…</> : '⬇  Download Resume'}
        </button>
        {resume.job_link && (
          <button className="secondary" onClick={copyLink}>
            {copiedLink ? '✓ Link copied' : 'Copy job link'}
          </button>
        )}
        {isApplied ? (
          <button className="secondary" onClick={onRevert}
            title="Mark this resume as not yet applied">
            ↺ Revert to pending
          </button>
        ) : (
          <button onClick={onMarkApplied}>
            Mark as applied
          </button>
        )}
      </div>

      {/* Inline PDF preview */}
      <div style={{
        marginBottom: '1.25rem',
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--panel-2)',
        position: 'relative',
        minHeight: 480,
        overflow: 'hidden',
      }}>
        {pdfLoading && !pdfUrl && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 10, color: 'var(--muted)', fontSize: '0.88rem',
          }}>
            <span className="spinner" style={{ width: '1.6em', height: '1.6em' }} />
            Rendering PDF preview…
          </div>
        )}
        {pdfError && !pdfLoading && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 6, padding: 20, textAlign: 'center',
            color: '#fca5a5', fontSize: '0.88rem',
          }}>
            ✗ {pdfError}
          </div>
        )}
        {pdfUrl && (
          <iframe
            src={pdfUrl}
            title={`Resume preview · ${resume.job_company}`}
            style={{ width: '100%', height: 820, border: 'none', display: 'block', background: 'white' }}
          />
        )}
      </div>

      {/* Q&A */}
      {answers.length > 0 ? (
        <div>
          <div className="section-title">
            Application Answers · click any answer to copy
          </div>
          {answers.map((a, i) => (
            <AnswerCard key={i} question={a.question} answer={a.answer} idx={i} />
          ))}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: '0.86rem' }}>
          No application questions for this job.
        </div>
      )}
    </div>
  );
}

// ─── Card-index strip ────────────────────────────────────────────────────
function IndexStrip({ resumes, current, onPick }: {
  resumes: SavedResume[];
  current: number;
  onPick: (i: number) => void;
}) {
  if (resumes.length <= 1) return null;
  // Limit visible chips to a sane window around current
  const max = 30;
  let start = 0, end = resumes.length;
  if (resumes.length > max) {
    start = Math.max(0, current - Math.floor(max / 2));
    end = Math.min(resumes.length, start + max);
    start = Math.max(0, end - max);
  }
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      {start > 0 && <span className="muted" style={{ fontSize: '0.78rem' }}>…</span>}
      {Array.from({ length: end - start }, (_, k) => {
        const i = start + k;
        const r = resumes[i];
        const isCurrent = i === current;
        const isApplied = r.applied_status === 'applied';
        return (
          <button key={i}
            onClick={() => onPick(i)}
            className={isCurrent ? '' : 'secondary'}
            title={`${r.job_company} — ${r.job_title}${isApplied ? ' · applied' : ''}`}
            style={{
              padding: '0.18rem 0.55rem',
              fontSize: '0.75rem',
              minWidth: 32,
              boxShadow: 'none',
              borderRadius: 6,
              position: 'relative',
              ...(isApplied && !isCurrent
                ? { background: 'transparent', borderColor: 'rgba(16,185,129,0.35)', color: '#6ee7b7' }
                : {}),
            }}>
            {i + 1}{isApplied && <span style={{ marginLeft: 3, fontSize: '0.7em' }}>✓</span>}
          </button>
        );
      })}
      {end < resumes.length && <span className="muted" style={{ fontSize: '0.78rem' }}>…</span>}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────
export default function ToDoBidder({ profileId, profile }: { profileId: string; profile: Profile }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<AppliedFilter>('pending');
  const [cardIdx, setCardIdx] = useState(0);

  // PDF blob cache (resume id → blob URL). Survives card navigation.
  const pdfCacheRef = useRef<Map<string, { url: string; blob: Blob }>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const [pdfState, setPdfState] = useState<Record<string, { loading: boolean; error: string }>>({});
  // bump to re-render after cache changes
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  const fetchPdf = useCallback(async (r: SavedResume) => {
    const id = r.saved_resume_id;
    if (!id) return;
    if (pdfCacheRef.current.has(id) || inFlightRef.current.has(id)) return;
    inFlightRef.current.add(id);
    setPdfState((s) => ({ ...s, [id]: { loading: true, error: '' } }));
    try {
      // Use the id-keyed GET endpoint — server caches by id so this hits
      // every time after the first render (or after the save-time prerender).
      const res = await api.raw.get(`/api/resumes/${id}/pdf`, { responseType: 'blob' });
      const blob = res.data as Blob;
      if (!blob || blob.size === 0) throw new Error('Empty PDF — was the resume actually generated?');
      const url = URL.createObjectURL(blob);
      pdfCacheRef.current.set(id, { url, blob });
      setPdfState((s) => ({ ...s, [id]: { loading: false, error: '' } }));
      bump();
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'Failed to render PDF';
      setPdfState((s) => ({ ...s, [id]: { loading: false, error: msg } }));
    } finally {
      inFlightRef.current.delete(id);
    }
  }, []);

  // Revoke all cached blob URLs when profile changes or unmounts
  useEffect(() => {
    return () => {
      pdfCacheRef.current.forEach((v) => URL.revokeObjectURL(v.url));
      pdfCacheRef.current.clear();
      inFlightRef.current.clear();
      setPdfState({});
    };
  }, [profileId]);

  const { data, isLoading } = useQuery({
    queryKey: ['todo', 'bidder', profileId],
    queryFn: () => api.get<{ resumes: SavedResume[] }>(`/api/todo?profile_id=${profileId}`),
    enabled: !!profileId,
    // Auto-refresh every 60s so admin's newly-generated resumes show up
    // and stale "applied" state is corrected.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const allResumes: SavedResume[] = data?.resumes || [];

  // Counts per filter (for chip badges)
  const counts = useMemo(() => {
    const c = { all: allResumes.length, pending: 0, applied: 0 };
    for (const r of allResumes) {
      if (r.applied_status === 'applied') c.applied++;
      else c.pending++;
    }
    return c;
  }, [allResumes]);

  // Apply filter
  const resumes = useMemo(() => {
    if (filter === 'all') return allResumes;
    if (filter === 'applied') return allResumes.filter((r) => r.applied_status === 'applied');
    return allResumes.filter((r) => r.applied_status !== 'applied');
  }, [allResumes, filter]);

  // Reset when profile or filter changes
  useEffect(() => { setCardIdx(0); }, [profileId, filter]);

  const safeIdx = Math.min(cardIdx, Math.max(0, resumes.length - 1));
  const current = resumes[safeIdx];

  // Auto-load current card's PDF + prefetch next/prev
  useEffect(() => {
    if (!current) return;
    fetchPdf(current);
    // Prefetch neighbors (cheap because the server caches by content hash)
    if (resumes[safeIdx + 1]) fetchPdf(resumes[safeIdx + 1]);
    if (resumes[safeIdx - 1]) fetchPdf(resumes[safeIdx - 1]);
  }, [current?.saved_resume_id, safeIdx, fetchPdf]);

  const currentPdf = current ? pdfCacheRef.current.get(current.saved_resume_id) : undefined;
  const currentState = current ? pdfState[current.saved_resume_id] : undefined;

  const downloadPdf = useCallback(async () => {
    if (!current) return;
    const cached = pdfCacheRef.current.get(current.saved_resume_id);
    if (!cached) {
      toast('PDF still rendering — please wait', 'info');
      return;
    }
    const cleanName = (profile.name || 'Resume').trim() || 'Resume';
    const filename = `${cleanName} resume.pdf`;

    // Best path: File System Access API. The "Save File" dialog has a
    // real "Replace existing file?" prompt and writes in place, so the
    // bidder can always overwrite. Only works in a secure context
    // (HTTPS / localhost) and on Chromium browsers.
    const w = window as any;
    if (typeof w.showSaveFilePicker === 'function' && window.isSecureContext) {
      try {
        const handle = await w.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(cached.blob);
        await writable.close();
        toast(`Saved ${filename}`, 'success');
        return;
      } catch (e: any) {
        if (e?.name === 'AbortError') return;     // user cancelled — silent
        // Any other error → fall through to <a download>
      }
    }

    // Fallback for HTTP / Safari / Firefox: classic <a download>.
    // Browser decides overwrite vs. auto-rename; filename stays stable.
    const a = document.createElement('a');
    a.href = cached.url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast(`Downloaded ${filename}`, 'success');
  }, [current, toast, profile.name]);

  const markApplied = useCallback(async () => {
    if (!current || current.applied_status === 'applied') return;
    try {
      await api.post(`/api/resumes/${current.saved_resume_id}/apply`);
      qc.invalidateQueries({ queryKey: ['todo', 'bidder', profileId] });
      qc.invalidateQueries({ queryKey: ['resumes'] });
      qc.invalidateQueries({ queryKey: ['todo', 'meta'] });
      qc.invalidateQueries({ queryKey: ['metrics'] });
      toast('Marked as applied', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to mark applied', 'error');
    }
  }, [current, qc, toast, profileId]);

  const revertToPending = useCallback(async () => {
    if (!current || current.applied_status !== 'applied') return;
    try {
      await api.post(`/api/resumes/${current.saved_resume_id}/unapply`);
      qc.invalidateQueries({ queryKey: ['todo', 'bidder', profileId] });
      qc.invalidateQueries({ queryKey: ['resumes'] });
      qc.invalidateQueries({ queryKey: ['todo', 'meta'] });
      qc.invalidateQueries({ queryKey: ['metrics'] });
      toast('Reverted to pending', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to revert', 'error');
    }
  }, [current, qc, toast, profileId]);

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  return (
    <div className="bidder-grid">
      {/* ───── Left sidebar — profile info (sticky) ───── */}
      <aside className="bidder-sidebar">
        <div className="card bidder-profile-card">
          <div className="section-title" style={{ marginBottom: '0.9rem' }}>
            Profile · click any field to copy
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <CopyChip label="Full name" value={profile.name || ''} />
            <CopyChip label="Email" value={profile.email || ''} />
            <CopyChip label="Location" value={profile.location || ''} />
            <CopyChip label="Phone" value={profile.phone || ''} />
            <CopyChip label="LinkedIn" value={profile.linkedin || ''} />
            <CopyChip label="Portfolio" value={profile.portfolio || ''} />
          </div>

          {(profile.education_history || []).length > 0 && (
            <div style={{ marginTop: '1.1rem' }}>
              <div className="copy-chip-label" style={{ marginBottom: 8 }}>Education</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(profile.education_history || []).map((edu, i) => {
                  const text = [edu.degree, edu.university, edu.duration].filter(Boolean).join(', ');
                  return <CopyChip key={i} label={edu.university || `Education ${i + 1}`} value={text} />;
                })}
              </div>
            </div>
          )}

          {(profile.work_history || []).length > 0 && (
            <details style={{ marginTop: '1.1rem' }}>
              <summary style={{
                cursor: 'pointer', fontSize: '0.7rem', fontWeight: 600,
                color: 'var(--muted)', textTransform: 'uppercase',
                letterSpacing: '0.06em', userSelect: 'none', listStyle: 'none',
                padding: '0.3rem 0',
              }}>
                ▸ Work history ({(profile.work_history || []).length})
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                {(profile.work_history || []).map((w, i) => {
                  const text = [w.company_name, w.duration, w.location].filter(Boolean).join(' · ');
                  return <CopyChip key={i} label={w.company_name || `Role ${i + 1}`} value={text} />;
                })}
              </div>
            </details>
          )}
        </div>
      </aside>

      {/* ───── Right column — filter, nav, card ───── */}
      <main className="bidder-main">

        {/* Unified header bar: filter chips on the left, nav on the right */}
        <div className="bidder-header-bar">
          <div className="chip-group">
            {([
              ['pending', `To Apply · ${counts.pending}`],
              ['applied', `Applied · ${counts.applied}`],
              ['all',     `All · ${counts.all}`],
            ] as const).map(([key, label]) => (
              <button key={key}
                className={filter === key ? 'active' : ''}
                onClick={() => setFilter(key as any)}>
                {label}
              </button>
            ))}
          </div>

          {resumes.length > 0 && (
            <div className="bidder-nav-cluster">
              <button className="secondary nav-btn"
                disabled={safeIdx === 0}
                onClick={() => setCardIdx(safeIdx - 1)}
                aria-label="Previous card">←</button>
              <span className="bidder-counter">
                <strong>{safeIdx + 1}</strong>
                <span className="muted">of {resumes.length}</span>
              </span>
              <button className="secondary nav-btn"
                disabled={safeIdx >= resumes.length - 1}
                onClick={() => setCardIdx(safeIdx + 1)}
                aria-label="Next card">→</button>
            </div>
          )}
        </div>

        {/* Card deck */}
        {resumes.length === 0 ? (
          <div className="card">
            <span className="muted">
              {filter === 'pending' && 'No pending applications. Wait for an admin to generate resumes for you.'}
              {filter === 'applied' && "You haven't marked any resumes as applied yet."}
              {filter === 'all'     && 'No generated resumes for this profile yet.'}
            </span>
          </div>
        ) : (
          <div>
            {/* Index strip — second row, full width */}
            {resumes.length > 1 && (
              <div className="bidder-index-row">
                <IndexStrip resumes={resumes} current={safeIdx} onPick={setCardIdx} />
              </div>
            )}

            {current && (
              <div key={current.saved_resume_id} className="bidder-card-fade">
                <ResumeCard
                  resume={current}
                  pdfUrl={currentPdf?.url || ''}
                  pdfLoading={!!currentState?.loading}
                  pdfError={currentState?.error || ''}
                  onDownload={downloadPdf}
                  onMarkApplied={markApplied}
                  onRevert={revertToPending}
                />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
