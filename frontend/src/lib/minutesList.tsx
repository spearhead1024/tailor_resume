import { useState } from 'react';

/* Shared by Settings (Notifications tab) and Account (each person's own creator/CBM reminder times).
   Creator/CBM heads-up TIMES are per-person, not global — see Account.tsx — so both pages need the
   same chip-editor and label formatting; this is the one place it's defined. */

/** Mirrors the server's wording, so previews/labels match exactly what will be pushed.
    60 -> "1 hour", 90 -> "1 hour 30 minutes". */
export function leadLabel(minutes: number): string {
  const n = Math.max(1, Math.round(minutes || 0));
  const h = Math.floor(n / 60), m = n % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/** Clamp/de-dupe/sort a list of lead-time minutes; empty or all-junk falls back to the default so a
    role can never end up silently un-configured (enabled but with nothing to fire). Pass `[]` as the
    fallback for a setting where "no times" is a legitimate, intentional choice (e.g. a person's own
    reminder list — leaving it empty means the system default applies, not "broken"). */
export function cleanMinutesList(values: number[], fallback: number[]): number[] {
  const out = Array.from(new Set(values.map((n) => Math.min(Math.max(Math.round(n) || 0, 5), 1440)).filter((n) => n >= 5)));
  out.sort((a, b) => a - b);
  return out.length ? out : fallback;
}

/** Chips of configured lead times (e.g. "1 hour 30 minutes ✕") plus an inline "+ Add" field. */
export function MinutesListEditor({ values, onChange, disabled }: {
  values: number[]; onChange: (next: number[]) => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const n = parseInt(draft, 10);
    if (!n || n < 5 || n > 1440) return;
    const next = Math.min(Math.max(n, 5), 1440);
    if (!values.includes(next)) onChange([...values, next].sort((a, b) => a - b));
    setDraft('');
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {values.length === 0 && <span className="muted" style={{ fontSize: '0.78rem' }}>No times set</span>}
      {values.map((n) => (
        <span key={n} style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 6px 3px 10px', borderRadius: 999,
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', fontSize: '0.8rem',
        }}>
          {leadLabel(n)}
          <button type="button" disabled={disabled} title="Remove this time"
            onClick={() => onChange(values.filter((v) => v !== n))}
            style={{ border: 'none', background: 'none', cursor: disabled ? 'default' : 'pointer', opacity: 0.6, padding: '0 2px', fontSize: '0.78rem', lineHeight: 1 }}>
            ✕
          </button>
        </span>
      ))}
      <input type="number" min={5} max={1440} placeholder="min" disabled={disabled} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        style={{ flex: '0 0 auto', width: 66 }} />
      <button type="button" className="secondary" disabled={disabled || !draft} onClick={add}
        style={{ padding: '2px 10px', fontSize: '0.78rem' }}>
        + Add
      </button>
    </div>
  );
}
