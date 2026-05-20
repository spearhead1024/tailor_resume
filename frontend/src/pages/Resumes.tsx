import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function formatDate(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function dayKey(iso: string) { return (iso || '').slice(0, 10); }

function AtsDisplay({ ats }: { ats: any }) {
  if (!ats) return <span className="muted">No ATS data.</span>;
  const cats: Record<string, number> = ats.category_scores || {};
  return (
    <div>
      <div style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '0.5rem' }}>
        {ats.overall_score ?? '?'} <span style={{ fontSize: '1rem', color: 'var(--muted)' }}>/ 100</span>
      </div>
      {Object.entries(cats).map(([k, v]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ width: 160, fontSize: '0.82rem', color: 'var(--muted)' }}>{k}</span>
          <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3 }}>
            <div style={{ width: `${Math.min(100, v)}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
          </div>
          <span style={{ width: 32, fontSize: '0.82rem', textAlign: 'right' }}>{v}</span>
        </div>
      ))}
      {(ats.strengths || []).map((s: string, i: number) => (
        <div key={i} style={{ fontSize: '0.83rem', marginTop: 4 }}>✓ {s}</div>
      ))}
      {(ats.risks || []).map((r: string, i: number) => (
        <div key={i} style={{ fontSize: '0.83rem', color: 'var(--danger, #e55)', marginTop: 4 }}>⚠ {r}</div>
      ))}
      {(ats.missing_keywords || []).length > 0 && (
        <div style={{ marginTop: '0.75rem', fontSize: '0.82rem', color: 'var(--muted)' }}>
          <strong>Missing:</strong> {ats.missing_keywords.join(', ')}
        </div>
      )}
    </div>
  );
}

function ResumeItem({ item, profiles, jobs }: { item: any; profiles: any[]; jobs: any[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('snapshot');
  const [companyMsg, setCompanyMsg] = useState(item.company_message || '');
  const [questions, setQuestions] = useState(item.job?.note || '');
  const [answers, setAnswers] = useState<any>(null);
  const [pdfUrl, setPdfUrl] = useState('');

  const profile = profiles.find((p) => p.id === item.profile_id);
  const job = jobs.find((j) => j.id === item.job_id);
  const atsScore = item.ats_score ?? item.ats?.overall_score;

  const saveMsgMutation = useMutation({
    mutationFn: () => api.patch(`/api/resumes/${item.id || item.saved_resume_id}`, { company_message: companyMsg }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['resumes'] }),
  });

  const answersMutation = useMutation({
    mutationFn: () => api.post<any>('/api/resumes/answers', {
      resume: item.resume,
      job_description: item.job_description,
      questions: questions.split('\n').map((q: string) => q.trim()).filter(Boolean),
      target_role: item.target_role,
    }),
    onSuccess: (r) => setAnswers(r),
  });

  const exportPdf = useCallback(async () => {
    try {
      const res = await api.raw.post('/api/resumes/export-pdf',
        { profile_id: item.profile_id, resume: item.resume },
        { responseType: 'blob' });
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(URL.createObjectURL(res.data));
    } catch {}
  }, [item.profile_id, item.resume, pdfUrl]);

  const resumeId = item.id || item.saved_resume_id || '—';

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      {/* Row */}
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0.7rem 0', cursor: 'pointer' }}>
        <span style={{ flex: '0 0 180px', fontWeight: 600 }}>{item.job_company || '—'}</span>
        <span style={{ flex: '0 0 160px', color: 'var(--muted)', fontSize: '0.85rem' }}>{profile?.name || item.profile_id || '—'}</span>
        <span style={{ flex: '0 0 70px', fontSize: '0.85rem' }}>
          {atsScore != null ? <strong>{atsScore}/100</strong> : <span className="muted">—</span>}
        </span>
        <span style={{ flex: '0 0 110px', fontSize: '0.82rem', color: 'var(--muted)' }}>{formatDate(item.created_at)}</span>
        <span style={{ flex: '0 0 100px', fontSize: '0.82rem', color: 'var(--muted)' }}>{item.created_by_username || '—'}</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </div>

      {/* Expanded detail */}
      {open && (
        <div style={{ paddingBottom: '1rem' }}>
          <div className="tabs" style={{ flexWrap: 'wrap', marginBottom: '1rem' }}>
            {['snapshot', 'ats', 'answers', 'jd', 'download'].map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t === 'snapshot' ? 'Snapshot' : t === 'ats' ? 'ATS Score' : t === 'answers' ? 'App. Answers' : t === 'jd' ? 'Job Description' : 'Download'}
              </button>
            ))}
          </div>

          {tab === 'snapshot' && (
            <div>
              <div style={{ fontSize: '0.83rem', color: 'var(--muted)', marginBottom: 8 }}>
                <span>ID: {resumeId}</span>
                <span style={{ margin: '0 12px' }}>·</span>
                <span>Created: {item.created_at || '—'}</span>
                {item.job_link && <><span style={{ margin: '0 12px' }}>·</span><a href={item.job_link} target="_blank" rel="noreferrer">Job link ↗</a></>}
              </div>
              <div className="field">
                <label>Company message / application email</label>
                <textarea rows={5} value={companyMsg} onChange={(e) => setCompanyMsg(e.target.value)} />
              </div>
              <button onClick={() => saveMsgMutation.mutate()} disabled={saveMsgMutation.isPending}>
                {saveMsgMutation.isPending ? <span className="spinner" /> : 'Save message'}
              </button>
            </div>
          )}

          {tab === 'ats' && <AtsDisplay ats={item.ats} />}

          {tab === 'answers' && (
            <div>
              <p className="muted">One question per line.</p>
              <textarea rows={5} value={questions} onChange={(e) => setQuestions(e.target.value)} />
              <button style={{ marginTop: 8 }} onClick={() => answersMutation.mutate()}
                disabled={!questions.trim() || answersMutation.isPending}>
                {answersMutation.isPending ? <span className="spinner" /> : 'Generate answers'}
              </button>
              {answers && (answers.answers || []).map((a: any, i: number) => (
                <div key={i} style={{ marginTop: '1rem' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Q{i + 1}. {a.question}</div>
                  <textarea rows={4} readOnly value={a.answer} style={{ userSelect: 'text' }} />
                </div>
              ))}
            </div>
          )}

          {tab === 'jd' && (
            <textarea rows={12} readOnly value={item.job_description || '—'} style={{ userSelect: 'text' }} />
          )}

          {tab === 'download' && (
            <div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={exportPdf}>{pdfUrl ? 'Re-render' : 'Render PDF'}</button>
                {pdfUrl && (
                  <a href={pdfUrl} download={`resume-${item.job_company || 'export'}.pdf`}>
                    <button className="secondary">Download PDF</button>
                  </a>
                )}
              </div>
              {pdfUrl && (
                <iframe src={pdfUrl} style={{ width: '100%', height: '800px', marginTop: 12, border: '1px solid var(--border)', borderRadius: 8 }} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Resumes() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;

  const [search, setSearch] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);

  const { data: resumes = [], isLoading: loadingResumes } = useQuery({
    queryKey: ['resumes'],
    queryFn: () => api.get<any[]>('/api/resumes'),
  });
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<any[]>('/api/profiles') });
  const { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: () => api.get<any[]>('/api/jobs') });

  const profilesById = Object.fromEntries(profiles.map((p: any) => [p.id, p]));

  // Build filter options
  const companies = [...new Set(resumes.map((r: any) => r.job_company).filter(Boolean))].sort() as string[];
  const profileNames = [...new Set(resumes.map((r: any) => profilesById[r.profile_id]?.name).filter(Boolean))].sort() as string[];

  // Filter
  const filtered = resumes.filter((r: any) => {
    const profileName = profilesById[r.profile_id]?.name || '';
    if (companyFilter && r.job_company !== companyFilter) return false;
    if (profileFilter && profileName !== profileFilter) return false;
    const day = dayKey(r.created_at);
    if (dateFrom && day < dateFrom) return false;
    if (dateTo && day > dateTo) return false;
    if (search) {
      const blob = [r.job_company, r.target_role, profileName, r.company_message, r.job_description].join(' ').toLowerCase();
      if (!blob.includes(search.toLowerCase())) return false;
    }
    return true;
  }).sort((a: any, b: any) => (b.created_at || '').localeCompare(a.created_at || ''));

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function goPage(n: number) { setPage(Math.max(1, Math.min(n, totalPages))); }

  if (loadingResumes) return <div><span className="spinner" /> Loading…</div>;

  return (
    <div>
      <h1>Resumes ({filtered.length})</h1>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '1rem', alignItems: 'center' }}>
        <input placeholder="Search company, profile, message…" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          style={{ maxWidth: 260 }} />
        <select value={companyFilter} onChange={(e) => { setCompanyFilter(e.target.value); setPage(1); }} style={{ maxWidth: 180 }}>
          <option value="">All companies</option>
          {companies.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={profileFilter} onChange={(e) => { setProfileFilter(e.target.value); setPage(1); }} style={{ maxWidth: 180 }}>
          <option value="">All profiles</option>
          {profileNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {isAdmin && (
          <>
            <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} style={{ maxWidth: 150 }} />
            <span className="muted">→</span>
            <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} style={{ maxWidth: 150 }} />
          </>
        )}
      </div>

      {/* Pagination top */}
      {filtered.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          {totalPages > 1 && (
            <>
              <button className="secondary" disabled={safePage === 1} onClick={() => goPage(safePage - 1)}>← Prev</button>
              <span className="muted" style={{ fontSize: '0.9rem' }}>Page {safePage} of {totalPages}</span>
              <button className="secondary" disabled={safePage === totalPages} onClick={() => goPage(safePage + 1)}>Next →</button>
            </>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="muted" style={{ fontSize: '0.8rem' }}>Rows</span>
            <select value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              style={{ width: 'auto', padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}>
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* List header */}
      {filtered.length === 0 ? (
        <div className="card"><span className="muted">No saved resumes match your filters.</span></div>
      ) : (
        <div className="card" style={{ padding: '0 1rem' }}>
          {/* Column headers */}
          <div style={{ display: 'flex', gap: 12, padding: '0.5rem 0', borderBottom: '2px solid var(--border)', fontSize: '0.8rem', fontWeight: 600, color: 'var(--muted)' }}>
            <span style={{ flex: '0 0 180px' }}>Company</span>
            <span style={{ flex: '0 0 160px' }}>Profile</span>
            <span style={{ flex: '0 0 70px' }}>ATS</span>
            <span style={{ flex: '0 0 110px' }}>Created</span>
            <span style={{ flex: '0 0 100px' }}>By</span>
          </div>

          {pageItems.map((item: any) => (
            <ResumeItem
              key={item.id || item.saved_resume_id}
              item={item}
              profiles={profiles}
              jobs={jobs}
            />
          ))}
        </div>
      )}

      {/* Pagination bottom */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: '0.75rem' }}>
          <button className="secondary" disabled={safePage === 1} onClick={() => goPage(safePage - 1)}>← Prev</button>
          <span className="muted" style={{ fontSize: '0.9rem' }}>Page {safePage} of {totalPages}</span>
          <button className="secondary" disabled={safePage === totalPages} onClick={() => goPage(safePage + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}
