import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { copyText } from '../lib/clipboard';

const PROFILE_STORAGE_KEY = 'resumes.selected_profile_id';
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

type Profile = {
  id: string;
  name: string;
  status?: 'active' | 'restricted';
  pending_count?: number;
  [k: string]: any;
};

type PendingJob = {
  id: string;
  company: string;
  job_title: string;
  region: string;
  submitted_at: string;
  approved_at: string;
};

import { etDateShort } from '../lib/etTime';

function formatDate(iso: string): string {
  return etDateShort(iso, '—');
}

function JobRow({
  job, profileId, onGeneratedJustNow,
}: {
  job: PendingJob;
  profileId: string;
  onGeneratedJustNow: boolean;
}) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [promptText, setPromptText] = useState('');

  async function fetchPrompt(): Promise<string> {
    if (promptText) return promptText;
    setLoadingPrompt(true);
    try {
      const res = await api.get<{ prompt: string }>(
        `/api/resumes/prompt?profile_id=${encodeURIComponent(profileId)}&job_id=${encodeURIComponent(job.id)}`
      );
      setPromptText(res.prompt);
      return res.prompt;
    } finally {
      setLoadingPrompt(false);
    }
  }

  async function handleCopy() {
    try {
      const text = await fetchPrompt();
      const ok = await copyText(text);
      toast(ok ? 'Prompt copied — paste into ChatGPT' : 'Copy failed', ok ? 'success' : 'error');
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to load prompt', 'error');
    }
  }

  async function handleExpand() {
    if (!expanded && !promptText) {
      try { await fetchPrompt(); }
      catch (e: any) { toast(e?.response?.data?.detail || 'Failed to load prompt', 'error'); return; }
    }
    setExpanded(!expanded);
  }

  return (
    <>
      <tr style={{ background: onGeneratedJustNow ? 'rgba(16,185,129,0.08)' : undefined }}>
        <td>{job.company}</td>
        <td>{job.job_title}</td>
        <td style={{ whiteSpace: 'nowrap', fontSize: '0.82rem' }}>{formatDate(job.submitted_at)}</td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="secondary" style={{ marginRight: 4 }} onClick={handleCopy} disabled={loadingPrompt}>
            {loadingPrompt ? <span className="spinner" /> : 'Copy Prompt'}
          </button>
          <button className="ghost" onClick={handleExpand}>{expanded ? '▲' : '▼'}</button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} style={{ background: 'var(--panel-2)', padding: '0.75rem 1rem' }}>
            <textarea
              readOnly
              rows={12}
              value={promptText}
              style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', userSelect: 'text' }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

export default function Resumes() {
  const qc = useQueryClient();
  const toast = useToast();
  const [profileId, setProfileId] = useState<string>(() => localStorage.getItem(PROFILE_STORAGE_KEY) || '');
  const [jsonText, setJsonText] = useState('');
  const [lastGeneratedJobId, setLastGeneratedJobId] = useState<string>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);

  // PDF preview state — blob URL of the most recently generated resume
  const [pdfUrl, setPdfUrl] = useState<string>('');
  const [pdfMeta, setPdfMeta] = useState<{ company: string; title: string } | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const pdfUrlRef = useRef<string>('');

  // Revoke blob URL on unmount or when a new one replaces it
  useEffect(() => {
    pdfUrlRef.current = pdfUrl;
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    };
  }, [pdfUrl]);

  const { data: meta, isLoading: metaLoading } = useQuery({
    queryKey: ['resumes', 'meta'],
    queryFn: () => api.get<{ profiles: Profile[] }>('/api/todo?for=resumes'),
    refetchInterval: 60_000,
  });
  const profiles: Profile[] = meta?.profiles || [];

  useEffect(() => {
    if (profileId) localStorage.setItem(PROFILE_STORAGE_KEY, profileId);
  }, [profileId]);

  useEffect(() => {
    if (profiles.length === 0) return;
    const current = profiles.find((p) => p.id === profileId);
    if (!current || current.status === 'restricted') {
      const firstActive = profiles.find((p) => p.status !== 'restricted');
      setProfileId((firstActive || profiles[0]).id);
    }
  }, [profiles, profileId]);

  // Reset to page 1 when switching profile (different job list)
  useEffect(() => { setPage(1); }, [profileId]);

  const { data: pendingJobs = [], isLoading: jobsLoading } = useQuery({
    queryKey: ['resumes', 'pending', profileId],
    queryFn: () => api.get<PendingJob[]>(`/api/resumes/pending?profile_id=${encodeURIComponent(profileId)}`),
    enabled: !!profileId,
    refetchInterval: 60_000,
  });

  async function fetchAndShowPdf(savedResumeId: string, jobCompany: string, jobTitle: string) {
    setPdfLoading(true);
    setPdfError('');
    setPdfMeta({ company: jobCompany, title: jobTitle });
    try {
      const res = await api.raw.get(`/api/resumes/${savedResumeId}/pdf`, { responseType: 'blob' });
      const blob = res.data as Blob;
      if (!blob || blob.size === 0) throw new Error('Empty PDF');
      // Revoke previous before replacing
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(blob);
      setPdfUrl(url);
      // PDF is rendered — now clear the JSON input
      setJsonText('');
    } catch (e: any) {
      let msg = e?.message || 'Failed to load PDF';
      const data = e?.response?.data;
      if (data instanceof Blob) {
        try {
          const text = await data.text();
          const parsed = JSON.parse(text);
          if (parsed?.detail) msg = parsed.detail;
        } catch { /* keep default */ }
      } else if (data?.detail) {
        msg = data.detail;
      }
      setPdfError(msg);
    } finally {
      setPdfLoading(false);
    }
  }

  const generateMutation = useMutation({
    mutationFn: (text: string) => api.post<{ ok: boolean; saved_resume_id: string; job_company: string; job_title: string }>(
      '/api/resumes/generate-from-json', { json_text: text, profile_id: profileId }
    ),
    onSuccess: async (res) => {
      toast(`Resume generated for ${res.job_company} — ${res.job_title}`, 'success');
      qc.invalidateQueries({ queryKey: ['resumes', 'pending', profileId] });
      qc.invalidateQueries({ queryKey: ['resumes', 'meta'] });
      qc.invalidateQueries({ queryKey: ['apply', 'meta'] });
      // Fetch + display PDF, then clear JSON input
      await fetchAndShowPdf(res.saved_resume_id, res.job_company, res.job_title);
    },
    onError: (e: any) => {
      toast(e?.response?.data?.detail || 'Failed to generate resume', 'error');
    },
  });

  const profile = profiles.find((p) => p.id === profileId);
  const selectedRestricted = profile?.status === 'restricted';
  const totalPending = profiles.reduce((sum, p) => sum + (p.pending_count || 0), 0);

  const sortedJobs = useMemo(
    () => [...pendingJobs].sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || '')),
    [pendingJobs],
  );

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sortedJobs.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageJobs = sortedJobs.slice((safePage - 1) * pageSize, safePage * pageSize);

  function goPage(n: number) {
    setPage(Math.max(1, Math.min(n, totalPages)));
  }

  function describe(p: Profile) {
    const status = p.status === 'restricted' ? 'Restricted' : 'Active';
    const n = p.pending_count ?? 0;
    return `${p.name} · ${status} · ${n} pending`;
  }

  if (metaLoading) return <div><span className="spinner" /> Loading…</div>;

  if (profiles.length === 0) {
    return (
      <div>
        <h1>Resumes</h1>
        <div className="card">
          <span className="muted">No accessible profiles. Ask an admin to assign one to your account.</span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>Resumes</h1>

      <div className="card" style={{
        marginBottom: '1.25rem', display: 'flex', alignItems: 'center',
        gap: 12, padding: '0.85rem 1.1rem', flexWrap: 'wrap',
      }}>
        <label style={{ margin: 0, fontSize: '0.78rem', whiteSpace: 'nowrap' }}>Profile</label>
        <select
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          style={{ width: 'auto', flex: '0 1 380px', minWidth: 220 }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id} disabled={p.status === 'restricted'}>
              {describe(p)}{p.status === 'restricted' ? ' (restricted)' : ''}
            </option>
          ))}
        </select>

        {profile && (
          <span className={`pill ${selectedRestricted ? 'rejected' : 'approved'}`}>
            {(profile.status || 'active').toUpperCase()}
          </span>
        )}

        <span style={{
          fontSize: '0.82rem', color: 'var(--muted)',
          paddingLeft: 8, borderLeft: '1px solid var(--border)',
        }}>
          Total pending across all profiles:{' '}
          <strong style={{ color: 'var(--text)' }}>{totalPending}</strong>
        </span>
      </div>

      {selectedRestricted ? (
        <div className="card">
          <span className="muted">This profile is <strong>restricted</strong> — select an active profile to continue.</span>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: '1rem', alignItems: 'start' }}>
          {/* ── LEFT: pending jobs with pagination ── */}
          <div className="card" style={{ padding: 0 }}>
            <div style={{
              padding: '0.7rem 1rem', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            }}>
              <div style={{ fontWeight: 600 }}>
                Jobs to generate{' '}
                {sortedJobs.length > 0 && (
                  <span className="muted" style={{ fontSize: '0.82rem', fontWeight: 400 }}>· {sortedJobs.length}</span>
                )}
              </div>
              <div style={{ flex: 1 }} />
              {sortedJobs.length > 0 && (
                <>
                  {totalPages > 1 && (
                    <>
                      <button className="secondary" disabled={safePage === 1} onClick={() => goPage(safePage - 1)}>← Prev</button>
                      <span className="muted" style={{ fontSize: '0.85rem' }}>Page {safePage} of {totalPages}</span>
                      <button className="secondary" disabled={safePage === totalPages} onClick={() => goPage(safePage + 1)}>Next →</button>
                    </>
                  )}
                  <span className="muted" style={{ fontSize: '0.78rem' }}>Rows</span>
                  <select value={pageSize}
                    onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                    style={{ width: 'auto', padding: '0.25rem 0.4rem', fontSize: '0.82rem' }}>
                    {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </>
              )}
            </div>
            {jobsLoading ? (
              <div style={{ padding: '1rem' }}><span className="spinner" /> Loading…</div>
            ) : sortedJobs.length === 0 ? (
              <div style={{ padding: '1rem' }}><span className="muted">No pending jobs for this profile.</span></div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Role</th>
                    <th style={{ whiteSpace: 'nowrap' }}>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pageJobs.map((j) => (
                    <JobRow
                      key={j.id}
                      job={j}
                      profileId={profileId}
                      onGeneratedJustNow={lastGeneratedJobId === j.id}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {totalPages > 1 && (
              <div style={{
                padding: '0.6rem 1rem', borderTop: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <button className="secondary" disabled={safePage === 1} onClick={() => goPage(safePage - 1)}>← Prev</button>
                <span className="muted" style={{ fontSize: '0.85rem' }}>Page {safePage} of {totalPages}</span>
                <button className="secondary" disabled={safePage === totalPages} onClick={() => goPage(safePage + 1)}>Next →</button>
              </div>
            )}
          </div>

          {/* ── RIGHT: JSON paste + PDF preview ── */}
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Paste ChatGPT JSON output</div>
            <p className="muted" style={{ fontSize: '0.82rem', marginTop: 0, marginBottom: '0.5rem' }}>
              Copy a prompt from the left, paste the JSON ChatGPT returns into the box below, then click Generate.
            </p>
            <textarea
              rows={8}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder='{"job_id": "job_xxx", "profile_id": "profile_xxx", "professional_summary": "...", "professional_experience": [...], "technical_skills": [...]}'
              style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '0.82rem' }}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: '0.6rem' }}>
              <button
                disabled={!jsonText.trim() || generateMutation.isPending || pdfLoading}
                onClick={() => {
                  try {
                    const parsed = JSON.parse(jsonText);
                    if (parsed?.job_id) setLastGeneratedJobId(parsed.job_id);
                  } catch { /* server validates */ }
                  generateMutation.mutate(jsonText);
                }}>
                {generateMutation.isPending || pdfLoading ? <span className="spinner" /> : 'Generate Resume'}
              </button>
              <button className="secondary" onClick={() => setJsonText('')}
                disabled={!jsonText.trim() || generateMutation.isPending || pdfLoading}>
                Clear
              </button>
              <span className="muted" style={{ fontSize: '0.8rem', marginLeft: 'auto' }}>
                {jsonText.trim().length} chars
              </span>
            </div>

            {/* ── PDF preview ── */}
            {(pdfLoading || pdfError || pdfUrl) && (
              <div style={{
                marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.5rem' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                    Generated PDF
                    {pdfMeta && (
                      <span className="muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: '0.82rem' }}>
                        · {pdfMeta.company} — {pdfMeta.title}
                      </span>
                    )}
                  </div>
                  <div style={{ flex: 1 }} />
                  {pdfUrl && !pdfLoading && (
                    <a href={pdfUrl} download={`${pdfMeta?.company || 'resume'}.pdf`} className="secondary"
                       style={{ padding: '0.3rem 0.6rem', textDecoration: 'none', fontSize: '0.82rem', borderRadius: 6, border: '1px solid var(--border)' }}>
                      ⬇ Download
                    </a>
                  )}
                </div>
                {pdfLoading ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center' }}>
                    <span className="spinner" /> Rendering PDF…
                  </div>
                ) : pdfError ? (
                  <div className="banner error" style={{ fontSize: '0.85rem' }}>✗ {pdfError}</div>
                ) : pdfUrl ? (
                  <iframe
                    title="Generated resume PDF"
                    src={pdfUrl}
                    style={{ width: '100%', height: 600, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
                  />
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
