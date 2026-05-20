import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../lib/toast';

const MODELS = ['gpt-5.1', 'gpt-5-nano', 'gpt-5-mini'];
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

type ProcStatus = 'pending' | 'generated' | 'skipped';

type AdminJob = {
  id: string;
  company: string;
  job_title: string;
  description: string;
  link: string;
  region: string;
  note: string;
  submitted_at: string;
  processing_status: ProcStatus;
  saved_resume_id: string;
};

type RunStatus = 'queued' | 'generating' | 'done' | 'failed';
type RunResult = { jobId: string; status: RunStatus; error?: string };

const STATUS_PILL: Record<ProcStatus, { label: string; cls: string }> = {
  pending:   { label: 'PENDING',   cls: 'pending' },
  generated: { label: 'GENERATED', cls: 'approved' },
  skipped:   { label: 'SKIPPED',   cls: 'rejected' },
};

export default function ToDoAdmin({ profileId }: { profileId: string }) {
  const qc = useQueryClient();
  const toast = useToast();

  // ── Settings ───────────────────────────────────────────────────────────
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<any>('/api/settings'),
  });
  const savedPrompts: any[] = settings?.saved_prompts || [];

  // ── Selection state ────────────────────────────────────────────────────
  const [model, setModel] = useState('gpt-5.1');
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ProcStatus>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Seed spear-1 prompt once
  useEffect(() => {
    if (!settings || defaultPrompt) return;
    const spear1 = savedPrompts.find((p: any) => p.name === 'spear-1');
    if (spear1) {
      setDefaultPrompt(spear1.text);
      setSelectedPromptId(spear1.id);
    } else {
      setDefaultPrompt(settings.default_prompt || '');
    }
  }, [settings]);

  // ── Run state ─────────────────────────────────────────────────────────
  const [results, setResults] = useState<RunResult[]>([]);
  const [running, setRunning] = useState(false);

  // ── Data ──────────────────────────────────────────────────────────────
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['todo', 'admin', profileId],
    queryFn: () => api.get<{ jobs: AdminJob[] }>(`/api/todo?profile_id=${profileId}`),
    enabled: !!profileId,
  });
  const allJobs: AdminJob[] = data?.jobs || [];

  // Clear local UI state when profile changes
  useEffect(() => { setSelected(new Set()); setResults([]); setPage(1); }, [profileId]);

  // Counts (for chip badges)
  const counts = useMemo(() => {
    const c = { all: allJobs.length, pending: 0, generated: 0, skipped: 0 };
    for (const j of allJobs) c[j.processing_status]++;
    return c;
  }, [allJobs]);

  // Apply filter
  const filtered = useMemo(
    () => statusFilter === 'all' ? allJobs : allJobs.filter((j) => j.processing_status === statusFilter),
    [allJobs, statusFilter]
  );

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageJobs = useMemo(
    () => filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, safePage, pageSize]
  );
  // Reset to page 1 when filter / page size changes
  useEffect(() => { setPage(1); }, [statusFilter, pageSize]);

  const selectedJobs = useMemo(() => allJobs.filter((j) => selected.has(j.id)), [allJobs, selected]);
  const allOnPageSelected = pageJobs.length > 0 && pageJobs.every((j) => selected.has(j.id));

  // Anchor for shift-click range select (index within current pageJobs).
  const lastClickedIdxRef = useRef<number | null>(null);

  /** Shift-aware row toggle. Click row → toggle one. Shift-click row → set
   *  every row between the last click and this one to whatever state the
   *  clicked row will end up in. */
  function handleRowToggle(idx: number, shiftKey: boolean) {
    const job = pageJobs[idx];
    if (!job) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const willBeSelected = !next.has(job.id);
      if (shiftKey && lastClickedIdxRef.current !== null) {
        const [from, to] = [lastClickedIdxRef.current, idx].sort((a, b) => a - b);
        for (let i = from; i <= to; i++) {
          const r = pageJobs[i];
          if (!r) continue;
          willBeSelected ? next.add(r.id) : next.delete(r.id);
        }
      } else {
        willBeSelected ? next.add(job.id) : next.delete(job.id);
      }
      return next;
    });
    lastClickedIdxRef.current = idx;
  }

  function toggleAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) pageJobs.forEach((j) => next.delete(j.id));
      else pageJobs.forEach((j) => next.add(j.id));
      return next;
    });
    lastClickedIdxRef.current = null;
  }

  // ── Mutations ─────────────────────────────────────────────────────────
  async function fireGeneration(jobIds?: string[]) {
    const targetIds = jobIds || selectedJobs.map((j) => j.id);
    const targets = allJobs.filter((j) => targetIds.includes(j.id));
    if (targets.length === 0 || running) return;
    setRunning(true);
    setResults(targets.map((j) => ({ jobId: j.id, status: 'queued' })));

    for (let i = 0; i < targets.length; i++) {
      const job = targets[i];
      setResults((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: 'generating' } : r)));

      try {
        const gen = await api.post<{ resume: any; ats: any }>('/api/resumes/generate', {
          profile_id: profileId,
          job_id: job.id,
          job_description: job.description || '',
          target_role: job.job_title || '',
          default_prompt: defaultPrompt,
          model,
          use_ai: true,
        });

        const questions = (job.note || '').split('\n').map((q) => q.trim()).filter(Boolean);
        let application_answers: any[] = [];
        if (questions.length > 0) {
          try {
            const ans = await api.post<{ answers: any[] }>('/api/resumes/answers', {
              resume: gen.resume,
              job_description: job.description || '',
              questions,
              target_role: job.job_title || '',
              model,
            });
            application_answers = (ans.answers || []).map((a: any) => ({
              question: a.question || '',
              answer: a.answer || '',
            }));
          } catch { /* answers best-effort */ }
        }

        // If we're re-generating (record already exists), clear it first
        if (job.processing_status !== 'pending') {
          await api.post('/api/todo/reset', { profile_id: profileId, job_ids: [job.id] });
        }

        await api.post('/api/resumes/save', {
          payload: {
            profile_id: profileId,
            job_id: job.id,
            job_company: job.company,
            job_title: job.job_title,
            job_link: job.link,
            job_region: job.region,
            job_description: job.description,
            target_role: job.job_title,
            resume: gen.resume,
            ats_score: gen.ats?.overall_score || 0,
            application_answers,
            status: 'generated',
            applied_status: 'pending',
          },
        });
        // Server pre-renders the PDF in a background task on save, so the
        // first bidder view will hit the id-keyed cache.

        setResults((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: 'done' } : r)));
      } catch (e: any) {
        const detail = e?.response?.data?.detail || e?.message || 'Generation failed';
        setResults((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: 'failed', error: detail } : r)));
      }
    }

    setRunning(false);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ['todo'] });
    qc.invalidateQueries({ queryKey: ['resumes'] });
    toast('Generation complete', 'success');
  }

  async function skipJobs(jobIds: string[]) {
    if (jobIds.length === 0 || running) return;
    await api.post('/api/todo/skip', { profile_id: profileId, job_ids: jobIds });
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ['todo'] });
    toast(`Skipped ${jobIds.length} job${jobIds.length === 1 ? '' : 's'}`, 'success');
  }

  async function resetJobs(jobIds: string[]) {
    if (jobIds.length === 0 || running) return;
    await api.post('/api/todo/reset', { profile_id: profileId, job_ids: jobIds });
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ['todo'] });
    toast(`Reset ${jobIds.length} job${jobIds.length === 1 ? '' : 's'}`, 'success');
  }

  if (isLoading) return <div><span className="spinner" /> Loading jobs…</div>;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div>
      {/* ── Toolbar ───────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: '1rem', padding: '0.9rem 1.1rem' }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0, flex: '0 0 150px' }}>
            <label>Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, flex: '0 0 200px' }}>
            <label>Prompt template</label>
            <select value={selectedPromptId} onChange={(e) => {
              const p = savedPrompts.find((p: any) => p.id === e.target.value);
              setSelectedPromptId(e.target.value);
              if (p) setDefaultPrompt(p.text);
              else if (settings?.default_prompt) setDefaultPrompt(settings.default_prompt);
            }}>
              <option value="">— none —</option>
              {savedPrompts.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }} />

          {selectedJobs.length > 0 && (
            <div className="selection-badge" role="status" aria-live="polite">
              <strong>{selectedJobs.length}</strong>
              <span>selected</span>
              <button
                type="button"
                className="ghost"
                style={{ padding: '0.15rem 0.45rem', fontSize: '0.75rem', marginLeft: 6 }}
                onClick={() => setSelected(new Set())}
                disabled={running}>
                Clear
              </button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="secondary"
              onClick={() => skipJobs(selectedJobs.map((j) => j.id))}
              disabled={selectedJobs.length === 0 || running}>
              Skip ({selectedJobs.length})
            </button>
            <button
              onClick={() => fireGeneration()}
              disabled={selectedJobs.length === 0 || running}>
              {running ? <><span className="spinner" /> Generating…</> : `Generate (${selectedJobs.length})`}
            </button>
          </div>
        </div>
      </div>

      {/* ── Status filter + pagination row ──────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '0.85rem', flexWrap: 'wrap' }}>
        <div className="chip-group">
          {([
            ['all',       `All · ${counts.all}`],
            ['pending',   `Pending · ${counts.pending}`],
            ['generated', `Generated · ${counts.generated}`],
            ['skipped',   `Skipped · ${counts.skipped}`],
          ] as const).map(([key, label]) => (
            <button key={key}
              className={statusFilter === key ? 'active' : ''}
              onClick={() => setStatusFilter(key as any)}>
              {label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="muted" style={{ fontSize: '0.8rem' }}>Rows</span>
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
            style={{ width: 'auto', padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}>
            {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button className="secondary" style={{ padding: '0.3rem 0.65rem', fontSize: '0.82rem' }}
              disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>← Prev</button>
            <span className="muted" style={{ fontSize: '0.85rem', minWidth: 90, textAlign: 'center' }}>
              Page {safePage} of {totalPages}
            </span>
            <button className="secondary" style={{ padding: '0.3rem 0.65rem', fontSize: '0.82rem' }}
              disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>Next →</button>
          </div>
        )}
        {isFetching && !isLoading && <span className="spinner" style={{ marginLeft: 4 }} />}
      </div>

      {/* ── Run progress panel ──────────────────────────────────────── */}
      {results.length > 0 && (
        <ProgressPanel results={results} jobs={allJobs} onDismiss={() => setResults([])} />
      )}

      {/* ── Table ───────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="card">
          <span className="muted">No jobs match the current filter.</span>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 38 }} />
              <col style={{ width: '20%' }} />
              <col />
              <col style={{ width: 70 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 60 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 200 }} />
            </colgroup>
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={allOnPageSelected} onChange={toggleAllOnPage}
                    style={{ width: 16, height: 16, margin: 0, cursor: 'pointer' }} />
                </th>
                <th>Company</th>
                <th>Job title</th>
                <th>Region</th>
                <th>AddedAt</th>
                <th style={{ textAlign: 'center' }}>Q</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageJobs.map((job, rowIdx) => {
                const checked = selected.has(job.id);
                const qCount = (job.note || '').split('\n').filter((l) => l.trim()).length;
                const sp = STATUS_PILL[job.processing_status];
                return (
                  <tr key={job.id}
                    style={{ background: checked ? 'var(--accent-glow)' : '' }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked}
                        // Use onClick (not onChange) to capture shiftKey reliably.
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRowToggle(rowIdx, e.shiftKey);
                        }}
                        onChange={() => { /* handled by onClick */ }}
                        style={{ width: 16, height: 16, margin: 0, cursor: 'pointer' }} />
                    </td>
                    <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={job.company}>
                      {job.company || '—'}
                    </td>
                    <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={job.job_title}>
                      {job.link ? (
                        <a href={job.link} target="_blank" rel="noreferrer">{job.job_title || '—'}</a>
                      ) : (job.job_title || '—')}
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>{job.region || '—'}</td>
                    <td style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
                      {(job.submitted_at || '').slice(0, 10) || '—'}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {qCount > 0 ? <span className="pill">{qCount}</span> : <span className="muted">·</span>}
                    </td>
                    <td>
                      <span className={`pill ${sp.cls}`}>{sp.label}</span>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <RowActions
                        job={job}
                        running={running}
                        onGenerate={() => fireGeneration([job.id])}
                        onSkip={() => skipJobs([job.id])}
                        onReset={() => resetJobs([job.id])}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RowActions({
  job, running, onGenerate, onSkip, onReset,
}: {
  job: AdminJob;
  running: boolean;
  onGenerate: () => void;
  onSkip: () => void;
  onReset: () => void;
}) {
  const btn = { padding: '0.28rem 0.7rem', fontSize: '0.78rem', marginLeft: 4 } as const;

  if (job.processing_status === 'pending') {
    return (
      <>
        <button style={btn} disabled={running} onClick={onGenerate}>Generate</button>
        <button className="secondary" style={btn} disabled={running} onClick={onSkip}>Skip</button>
      </>
    );
  }
  if (job.processing_status === 'generated') {
    return (
      <>
        <button className="secondary" style={btn} disabled={running} onClick={onGenerate}>Regenerate</button>
        <button className="ghost" style={btn} disabled={running} onClick={onReset}>Reset</button>
      </>
    );
  }
  // skipped
  return (
    <>
      <button style={btn} disabled={running} onClick={onGenerate}>Generate</button>
      <button className="ghost" style={btn} disabled={running} onClick={onReset}>Un-skip</button>
    </>
  );
}

function ProgressPanel({ results, jobs, onDismiss }: {
  results: RunResult[];
  jobs: AdminJob[];
  onDismiss: () => void;
}) {
  const total = results.length;
  const done = results.filter((r) => r.status === 'done').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const allComplete = results.every((r) => r.status === 'done' || r.status === 'failed');
  const jobMap = useMemo(() => Object.fromEntries(jobs.map((j) => [j.id, j])), [jobs]);

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <strong style={{ fontSize: '0.95rem' }}>
          {allComplete ? 'Generation complete' : 'Generating…'}
        </strong>
        <span className="muted" style={{ fontSize: '0.83rem' }}>
          {done} done
          {failed > 0 && <> · <span style={{ color: 'var(--danger)' }}>{failed} failed</span></>}
          {' '}of {total}
        </span>
        {allComplete && <button className="ghost" style={{ marginLeft: 'auto' }} onClick={onDismiss}>Dismiss</button>}
      </div>
      <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: `${(100 * (done + failed)) / total}%`,
          height: '100%',
          background: failed > 0 ? 'var(--warning)' : 'var(--accent)',
          transition: 'width 0.25s',
        }} />
      </div>
      <div style={{ marginTop: 12, maxHeight: 220, overflowY: 'auto', fontSize: '0.83rem' }}>
        {results.map((r, i) => {
          const job = jobMap[r.jobId];
          const color = r.status === 'done' ? 'var(--success)'
            : r.status === 'failed' ? 'var(--danger)'
            : r.status === 'generating' ? 'var(--accent)' : 'var(--muted)';
          const label = r.status === 'queued' ? '· queued'
            : r.status === 'generating' ? '↻ running'
            : r.status === 'done' ? '✓ done' : '✗ failed';
          return (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '4px 0' }}>
              <span style={{ width: 90, color, flexShrink: 0 }}>{label}</span>
              <span style={{ flex: 1, color: 'var(--text-soft)' }}>
                {job ? `${job.company} — ${job.job_title}` : r.jobId}
              </span>
              {r.error && <span className="muted" style={{ fontSize: '0.78rem' }}>{r.error}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
