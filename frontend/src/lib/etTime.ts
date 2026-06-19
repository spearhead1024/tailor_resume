// All wall-clock timestamps in the UI render in US Eastern. Job deadlines
// and "today" semantics are computed server-side in ET as well, so these
// helpers keep the displayed dates and the backend filter aligned.
const ET = 'America/New_York';

function safeDate(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** "YYYY-MM-DD" in US Eastern. Used wherever code previously did iso.slice(0,10). */
export function etDateKey(iso: string): string {
  const d = safeDate(iso);
  if (!d) return '';
  // en-CA gives ISO-style "YYYY-MM-DD" output.
  return d.toLocaleDateString('en-CA', { timeZone: ET });
}

/** Today's date as "YYYY-MM-DD" in US Eastern. */
export function todayETKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: ET });
}

/** "May 31, 2026" in US Eastern. */
export function etDateLong(iso: string, fallback = '—'): string {
  const d = safeDate(iso);
  if (!d) return fallback;
  return d.toLocaleDateString('en-US', {
    timeZone: ET, year: 'numeric', month: 'long', day: 'numeric',
  });
}

/** "May 31, 2026" (short month) in US Eastern. */
export function etDateShort(iso: string, fallback = '—'): string {
  const d = safeDate(iso);
  if (!d) return fallback;
  return d.toLocaleDateString('en-US', {
    timeZone: ET, year: 'numeric', month: 'short', day: 'numeric',
  });
}

/** "May 31, 2026, 3:42 PM ET" — full date + time in US Eastern with the ET suffix. */
export function etDateTime(iso: string, fallback = '—'): string {
  const d = safeDate(iso);
  if (!d) return fallback;
  const s = d.toLocaleString('en-US', {
    timeZone: ET,
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  return `${s} ET`;
}
