import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

type Tab = 'preview' | 'edit' | 'exports' | 'ats' | 'answers' | 'data' | 'profile';

export default function Resumes() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [profileId, setProfileId] = useState('');
  const [jobId, setJobId] = useState(params.get('job_id') || '');
  const [targetRole, setTargetRole] = useState('');
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [resume, setResume] = useState<any | null>(null);
  const [ats, setAts] = useState<any | null>(null);
  const [tab, setTab] = useState<Tab>('preview');
  const [fixPrompt, setFixPrompt] = useState('');
  const [questions, setQuestions] = useState('');
  const [answers, setAnswers] = useState<any | null>(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [error, setError] = useState('');

  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<any[]>('/api/profiles') });
  const { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: () => api.get<any[]>('/api/jobs') });
  const { data: savedResumes = [] } = useQuery({ queryKey: ['resumes'], queryFn: () => api.get<any[]>('/api/resumes') });

  const selectedJob = jobs.find((j: any) => j.id === jobId);
  const jobDescription = selectedJob?.description || '';

  const generateMutation = useMutation({
    mutationFn: () => api.post<{ resume: any; ats: any; mode: string }>('/api/resumes/generate', {
      profile_id: profileId,
      job_id: jobId || undefined,
      job_description: jobDescription,
      target_role: targetRole,
      default_prompt: defaultPrompt,
      use_ai: useAi,
    }),
    onSuccess: (r) => {
      setResume(r.resume);
      setAts(r.ats);
      setPdfUrl('');
      setError('');
    },
    onError: (e: any) => setError(e?.response?.data?.detail || 'Generation failed'),
  });

  const updateMutation = useMutation({
    mutationFn: () => api.post<{ resume: any; ats: any }>('/api/resumes/update', {
      profile_id: profileId,
      job_description: jobDescription,
      target_role: targetRole,
      current_resume: resume,
      fix_prompt: fixPrompt,
      default_prompt: defaultPrompt,
    }),
    onSuccess: (r) => {
      setResume(r.resume);
      setAts(r.ats);
      setPdfUrl('');
      setFixPrompt('');
    },
  });

  const saveMutation = useMutation({
    mutationFn: () => api.post('/api/resumes/save', {
      payload: {
        profile_id: profileId,
        job_id: jobId,
        resume,
        ats,
        target_role: targetRole,
        job_description: jobDescription,
      },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['resumes'] }),
  });

  const answersMutation = useMutation({
    mutationFn: () => api.post<any>('/api/resumes/answers', {
      resume,
      job_description: jobDescription,
      questions: questions.split('\n').map((q) => q.trim()).filter(Boolean),
      target_role: targetRole,
    }),
    onSuccess: (r) => setAnswers(r),
  });

  async function exportPdf() {
    setError('');
    try {
      const res = await api.raw.post('/api/resumes/export-pdf', { profile_id: profileId, resume }, {
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      setPdfUrl(url);
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'PDF export failed');
    }
  }

  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  return (
    <div>
      <h1>Resumes</h1>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="row">
          <div className="field">
            <label>Profile</label>
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">— select —</option>
              {profiles.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Job</label>
            <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">— select —</option>
              {jobs.filter((j: any) => j.status === 'approved').map((j: any) => (
                <option key={j.id} value={j.id}>{j.company} — {j.job_title}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Target role (optional)</label>
            <input value={targetRole} onChange={(e) => setTargetRole(e.target.value)} placeholder="e.g. Senior Backend Engineer" />
          </div>
        </div>
        <div className="field">
          <label>Default prompt / guidance (optional)</label>
          <textarea rows={2} value={defaultPrompt} onChange={(e) => setDefaultPrompt(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" style={{ width: 16 }} checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
            Use AI (OpenAI)
          </label>
          <div style={{ flex: 1 }} />
          <button onClick={() => generateMutation.mutate()} disabled={!profileId || generateMutation.isPending}>
            {generateMutation.isPending ? <span className="spinner" /> : 'Generate resume'}
          </button>
        </div>
        {error && <div className="banner error" style={{ marginTop: 10 }}>{error}</div>}
        {resume && ats && (
          <div className="banner success" style={{ marginTop: 10 }}>
            Generated. <strong>ATS {ats.overall_score ?? '?'} / 100</strong>
          </div>
        )}
      </div>

      {resume && (
        <div className="card">
          <div className="tabs">
            <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Preview</button>
            <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>Edit & Fix</button>
            <button className={tab === 'exports' ? 'active' : ''} onClick={() => setTab('exports')}>Exports</button>
            <button className={tab === 'ats' ? 'active' : ''} onClick={() => setTab('ats')}>ATS Notes</button>
            <button className={tab === 'answers' ? 'active' : ''} onClick={() => setTab('answers')}>Job Application Answers</button>
            <button className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')}>Structured Data</button>
            <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>Source Profile</button>
          </div>

          {tab === 'preview' && (
            <div>
              <p className="muted">Read-only PDF preview. The PDF is generated from the uploaded DOCX template.</p>
              {!pdfUrl ? (
                <button onClick={exportPdf}>Render PDF preview</button>
              ) : (
                <iframe src={pdfUrl} style={{ width: '100%', height: '900px', border: '1px solid var(--border)', borderRadius: 8 }} />
              )}
            </div>
          )}

          {tab === 'edit' && (
            <div>
              <p className="muted">Describe what to fix or improve and the AI will revise the resume in place.</p>
              <textarea rows={5} value={fixPrompt} onChange={(e) => setFixPrompt(e.target.value)}
                placeholder="e.g. Emphasize Kubernetes experience and tighten the summary…" />
              <button style={{ marginTop: 8 }} onClick={() => updateMutation.mutate()}
                disabled={!fixPrompt.trim() || updateMutation.isPending}>
                {updateMutation.isPending ? <span className="spinner" /> : 'Apply fix'}
              </button>
              <button className="secondary" style={{ marginTop: 8, marginLeft: 8 }} onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <span className="spinner" /> : 'Save resume'}
              </button>
            </div>
          )}

          {tab === 'exports' && (
            <div>
              <p className="muted">Download the rendered PDF.</p>
              <button onClick={exportPdf}>{pdfUrl ? 'Re-render' : 'Render PDF'}</button>
              {pdfUrl && (
                <a href={pdfUrl} download="resume.pdf" style={{ marginLeft: 10 }}>
                  <button className="secondary">Download PDF</button>
                </a>
              )}
            </div>
          )}

          {tab === 'ats' && ats && (
            <div>
              <h2>ATS Analysis — {ats.overall_score} / 100</h2>
              <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel-2)', padding: 12, borderRadius: 8, fontSize: '0.85rem' }}>
                {JSON.stringify(ats, null, 2)}
              </pre>
            </div>
          )}

          {tab === 'answers' && (
            <div>
              <p className="muted">Write one question per line. Answers stay short, direct, and grounded in the resume + JD.</p>
              <textarea rows={6} value={questions} onChange={(e) => setQuestions(e.target.value)}
                placeholder="Why are you a fit for this role?&#10;Describe a recent technical challenge." />
              <button style={{ marginTop: 8 }} onClick={() => answersMutation.mutate()} disabled={!questions.trim() || answersMutation.isPending}>
                {answersMutation.isPending ? <span className="spinner" /> : 'Generate answers'}
              </button>
              {answers && (
                <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel-2)', padding: 12, borderRadius: 8, marginTop: 10, fontSize: '0.85rem' }}>
                  {JSON.stringify(answers, null, 2)}
                </pre>
              )}
            </div>
          )}

          {tab === 'data' && (
            <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel-2)', padding: 12, borderRadius: 8, fontSize: '0.8rem', maxHeight: 700, overflow: 'auto' }}>
              {JSON.stringify(resume, null, 2)}
            </pre>
          )}

          {tab === 'profile' && profileId && (
            <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel-2)', padding: 12, borderRadius: 8, fontSize: '0.8rem' }}>
              {JSON.stringify(profiles.find((p: any) => p.id === profileId), null, 2)}
            </pre>
          )}
        </div>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        <h2>Saved resumes ({savedResumes.length})</h2>
        {savedResumes.length === 0 ? (
          <p className="muted">No saved resumes yet.</p>
        ) : (
          <table>
            <thead><tr><th>Profile</th><th>Job</th><th>ATS</th><th>Created</th></tr></thead>
            <tbody>
              {savedResumes.map((r: any) => (
                <tr key={r.id}>
                  <td>{profiles.find((p: any) => p.id === r.profile_id)?.name || r.profile_id}</td>
                  <td>{jobs.find((j: any) => j.id === r.job_id)?.job_title || r.job_id || '—'}</td>
                  <td>{r.ats?.overall_score ?? '—'}</td>
                  <td>{(r.created_at || '').slice(0, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
