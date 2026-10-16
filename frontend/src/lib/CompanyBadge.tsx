/* Startup / size / age badge for a company, shown wherever a job's company appears.
 *
 * Data comes from the company-intel worker (backend core/company_intel.py) and is
 * attached to job rows as `company_info`. Startup = under 100 employees OR founded
 * within 10 years, never if publicly traded. Size is shown for EVERY company,
 * startup or not; estimates are labelled "(est.)". Admins can correct a company
 * (locked from automatic re-checks) or ask for a fresh check.
 */
import { api } from '../api/client';

export type CompanyInfo = {
  key: string;
  name: string;
  status: 'pending' | 'done' | 'error';
  verdict?: 'startup' | 'not_startup' | 'unknown';
  reason?: string;
  size_label?: string;
  founded_label?: string;
  employees?: number | null;
  founded?: number | null;
  public?: boolean;
  confidence?: 'high' | 'medium' | 'low';
  sources?: string[];
  locked?: boolean;
  domain?: string;
};

const PILL: Record<string, { label: string; bg: string; fg: string }> = {
  startup:     { label: 'Startup',     bg: 'rgba(22,163,74,0.16)',   fg: '#4ade80' },
  not_startup: { label: 'Not startup', bg: 'rgba(148,163,184,0.16)', fg: '#94a3b8' },
  unknown:     { label: 'Unknown',     bg: 'rgba(234,179,8,0.14)',   fg: '#facc15' },
  pending:     { label: 'Checking…',   bg: 'rgba(59,130,246,0.14)',  fg: '#93c5fd' },
};

export default function CompanyBadge({ info, isAdmin, onChanged, compact }: {
  info?: CompanyInfo | null;
  isAdmin?: boolean;
  onChanged?: () => void;
  compact?: boolean;
}) {
  if (!info) return null;
  const pending = info.status === 'pending';
  const pill = PILL[pending ? 'pending' : (info.verdict || 'unknown')];
  const facts = pending ? '' : [info.size_label, info.founded_label].filter(Boolean).join(' · ');
  const tip = pending
    ? 'Checking company size and age…'
    : [
        info.reason ? `Why: ${info.reason}` : '',
        info.public ? 'Publicly traded' : '',
        info.domain ? `Website: ${info.domain}` : '',
        (info.sources || []).length ? `Sources: ${(info.sources || []).join('; ')}` : '',
        info.locked ? 'Set manually by an admin' : '',
      ].filter(Boolean).join('\n');

  const edit = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const emp = window.prompt(`Employees at ${info.name}? (number, blank = unknown)`, info.employees ? String(info.employees) : '');
    if (emp === null) return;
    const yr = window.prompt(`Year ${info.name} was founded? (blank = unknown)`, info.founded ? String(info.founded) : '');
    if (yr === null) return;
    try {
      await api.patch(`/api/companies/${encodeURIComponent(info.key)}`, {
        employees: emp.trim() === '' ? null : emp.trim(),
        founded: yr.trim() === '' ? null : yr.trim(),
      });
      onChanged?.();
    } catch (err: any) {
      window.alert(err?.response?.data?.detail || 'Could not save');
    }
  };
  const recheck = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try { await api.post(`/api/companies/${encodeURIComponent(info.key)}/recheck`); onChanged?.(); }
    catch { window.alert('Could not queue a re-check'); }
  };

  return (
    <span title={tip} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      fontSize: compact ? '0.72rem' : '0.76rem', lineHeight: 1.3 }}>
      <span style={{ background: pill.bg, color: pill.fg, borderRadius: 999, padding: '1px 8px', fontWeight: 600,
        whiteSpace: 'nowrap' }}>
        {pill.label}{info.locked ? ' ✓' : ''}
      </span>
      {facts && <span className="muted" style={{ whiteSpace: 'nowrap' }}>{facts}</span>}
      {isAdmin && !pending && (
        <>
          <button className="ghost" title="Correct size / founded year" onClick={edit}
            style={{ padding: '0 3px', fontSize: '0.75rem', lineHeight: 1 }}>✎</button>
          <button className="ghost" title="Re-check automatically" onClick={recheck}
            style={{ padding: '0 3px', fontSize: '0.75rem', lineHeight: 1 }}>↻</button>
        </>
      )}
    </span>
  );
}
