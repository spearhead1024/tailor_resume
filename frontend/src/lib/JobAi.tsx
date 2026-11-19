// The AI job check on screen (server: core/job_ai.py): a job's tech stack, its verdict badge, the
// side-by-side "Compare" view and the reject-with-a-reason dialog. Used by the Jobs tab (all lists +
// the Pending review), the Applied tab and the Interviews board.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { etDateShort } from './etTime';

/** A job's main tech stack as small chips. `max` shows the first N and a "+k" with the rest. */
export function TechStack({ stack, max = 6, style }: { stack?: string[]; max?: number; style?: React.CSSProperties }) {
  const list = (stack || []).filter(Boolean);
  if (!list.length) return null;
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return (
    <span className="stack-chips" style={style} title={`Tech stack: ${list.join(', ')}`}>
      {shown.map((s) => <span key={s} className="stack-chip">{s}</span>)}
      {rest > 0 && <span className="stack-chip more">+{rest}</span>}
    </span>
  );
}

const AI_LABEL: Record<string, string> = { fit: 'Fit', not_fit: 'Not fit', needs_check: 'Check' };
const AI_TITLE: Record<string, string> = {
  fit: 'AI: explicitly remote, paid software work, no clearance',
  not_fit: 'AI: onsite / hybrid / travel / in-person, not software, unpaid or clearance needed',
  needs_check: 'AI: the posting does not say where the work is — a person decides',
};

/** The AI verdict: Fit (green) / Not fit (red) / Check (blue), with its short reason. While a job
 *  waits for its check it shows "Checking…". `withReason` prints the reason under the badge. */
export function AiBadge({ job, withReason = true }: { job: any; withReason?: boolean }) {
  const st = String(job?.ai_status || '');
  if (!st) {
    if (job?.ai_auto && !job?.analyzed) {
      return <span className="ai-badge wait" title="The AI check is reading this job (a few seconds)"><span className="spinner" />Checking…</span>;
    }
    return null;
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span className={`ai-badge ${st}`} title={`${AI_TITLE[st] || ''}${job.ai_reason ? ` — ${job.ai_reason}` : ''}`}>
        {AI_LABEL[st] || st}
      </span>
      {withReason && job.ai_reason && <span className="ai-reason">{job.ai_reason}</span>}
    </span>
  );
}

/** Row tint for the Pending review: the AI verdict at a glance. */
export function aiRowStyle(job: any): React.CSSProperties | undefined {
  switch (job?.ai_status) {
    case 'fit': return { background: 'rgba(16,185,129,0.06)' };
    case 'not_fit': return { background: 'rgba(239,68,68,0.06)' };
    case 'needs_check': return { background: 'rgba(59,130,246,0.06)' };
    default: return undefined;
  }
}

function useEsc(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
}

// The usual reasons, one click each. Empty = each job keeps its own (report → AI reason → plain line).
const QUICK_REASONS = ['Onsite / hybrid', 'Remote not stated', 'Duplicate posting', 'Not a software role', 'Clearance required', 'Job is closed'];

/** Reject one or more jobs with a reason the person who added them will see. */
export function RejectDialog({ count, single, onClose, onConfirm }: {
  count: number; single?: any; onClose: () => void; onConfirm: (reason: string) => Promise<void> | void;
}) {
  // One job the AI marked Not fit / Check: its reason is the default text (edit it, or keep it).
  const [reason, setReason] = useState(() => (single?.ai_reason && single.ai_status && single.ai_status !== 'fit' ? String(single.ai_reason) : ''));
  const [busy, setBusy] = useState(false);
  useEsc(onClose);
  const auto = single
    ? (single.ai_reason && single.ai_status !== 'fit' ? `AI: ${single.ai_reason}` : 'Rejected after review')
    : 'each job’s own reason (its report, else its AI reason, else “Rejected after review”)';
  async function go() {
    setBusy(true);
    try { await onConfirm(reason.trim()); } finally { setBusy(false); }
  }
  return createPortal(
    <div className="cal-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cal-modal" role="dialog" aria-label="Reject jobs">
        <header className="cal-modal-h">
          <h3>Reject {single ? `“${single.company} — ${single.job_title}”` : `${count} job${count === 1 ? '' : 's'}`}</h3>
          <button className="ghost cal-modal-x" onClick={onClose} title="Close (Esc)">✕</button>
        </header>
        <div className="cal-modal-b" style={{ display: 'block' }}>
          <label className="cal-fld-l" htmlFor="rej-reason">Reason — the person who added it sees this</label>
          <textarea id="rej-reason" rows={2} autoFocus value={reason} maxLength={300}
            onFocus={(e) => e.currentTarget.select()}
            placeholder={`Empty: ${auto}`} onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go(); }}
            style={{ width: '100%', marginTop: 4 }} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {QUICK_REASONS.map((r) => (
              <button key={r} type="button" className={reason === r ? '' : 'secondary'} onClick={() => setReason(r)}
                style={{ padding: '2px 10px', fontSize: '0.8rem' }}>{r}</button>
            ))}
          </div>
        </div>
        <footer className="cal-modal-f">
          <span className="muted" style={{ fontSize: '0.8rem' }}>Ctrl+Enter to reject</span>
          <div style={{ flex: 1 }} />
          <button className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="danger" onClick={go} disabled={busy}>{busy ? <span className="spinner" /> : 'Reject'}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

const MATCH: Record<string, string> = { link: 'Same link', role: 'Same company + title', company: 'Same company' };

function JobPane({ job, head }: { job: any; head: React.ReactNode }) {
  return (
    <div className="cmp-pane">
      <div className="cmp-head">{head}</div>
      <div className="cmp-title">
        <strong>{job.company}</strong> — {job.link ? <a href={job.link} target="_blank" rel="noreferrer">{job.job_title}</a> : job.job_title}
      </div>
      <div className="cmp-meta">
        <span className={`pill ${job.status}`}>{job.status}</span>
        <span>{job.region}</span>
        <span>{etDateShort(job.submitted_at)}</span>
        {job.created_by_username && <span>by {job.created_by_username}</span>}
        <AiBadge job={job} withReason={false} />
        {job.ai_reason && <span className="ai-reason">{job.ai_reason}</span>}
      </div>
      <TechStack stack={job.tech_stack} max={12} style={{ margin: '4px 0 6px' }} />
      <div className="cmp-desc">{job.description || <span className="muted">No description.</span>}</div>
    </div>
  );
}

/** Side by side: this job next to up to 10 others like it (same link / company + title / company). */
export function CompareDialog({ jobId, onClose, actions }: {
  jobId: string; onClose: () => void; actions?: (job: any) => React.ReactNode;
}) {
  const [data, setData] = useState<{ job: any; similar: any[] } | null>(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState(0);
  useEsc(onClose);
  useEffect(() => {
    api.get<{ job: any; similar: any[] }>(`/api/jobs/${jobId}/similar`)
      .then(setData).catch((e) => setErr(e?.response?.data?.detail || e?.message || 'Could not load'));
  }, [jobId]);
  const other = data?.similar?.[pick];
  return createPortal(
    <div className="cal-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cal-modal cmp-modal" role="dialog" aria-label="Compare jobs">
        <header className="cal-modal-h">
          <h3>Compare — {data ? `${data.similar.length} similar job${data.similar.length === 1 ? '' : 's'}` : '…'}</h3>
          <button className="ghost cal-modal-x" onClick={onClose} title="Close (Esc)">✕</button>
        </header>
        <div className="cmp-body">
          {err && <p className="error" style={{ padding: 16 }}>{err}</p>}
          {!data && !err && <p className="muted" style={{ padding: 16 }}><span className="spinner" /> Loading…</p>}
          {data && (
            <>
              {data.similar.length > 0 && (
                <div className="cmp-tabs">
                  {data.similar.map((s, i) => (
                    <button key={s.id} className={i === pick ? '' : 'secondary'} onClick={() => setPick(i)} title={`${s.company} — ${s.job_title}`}>
                      {MATCH[s.match_kind] || s.match_kind} · {etDateShort(s.submitted_at)}
                    </button>
                  ))}
                </div>
              )}
              <div className="cmp-grid">
                <JobPane job={data.job} head={<span className="cmp-tag this">This job</span>} />
                {other
                  ? <JobPane job={other} head={<span className={`cmp-tag ${other.match_kind}`}>{MATCH[other.match_kind]}</span>} />
                  : <div className="cmp-pane cmp-empty">No other job with the same link or company — nothing to compare.</div>}
              </div>
            </>
          )}
        </div>
        {data && actions && <footer className="cal-modal-f">{actions(data.job)}</footer>}
      </div>
    </div>,
    document.body,
  );
}
