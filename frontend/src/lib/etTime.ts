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

/** "May 31, 2026, 3:42 PM PDT" — date + time in the viewer's own time zone: the one
 *  set on their Account (`tz`), else the browser's. The zone name is part of the text. */
export function userDateTime(iso: string, tz?: string, fallback = '—'): string {
  const d = safeDate(iso);
  if (!d) return fallback;
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  };
  try { return d.toLocaleString('en-US', { ...opts, timeZone: tz || undefined }); }
  catch { return d.toLocaleString('en-US', opts); }   // unknown zone id → browser zone
}

// ── The WORK DAY: 5pm JST → 5pm JST (08:00 UTC), labelled by the date it starts on ──
// The one "day" every tab counts by — Metrics (backend routers/metrics.py `_metrics_day`), Applied
// and Jobs — so a day's numbers agree from tab to tab. ("Mon 17" = Mon 17 5pm JST → Tue 18 5pm JST.)
const WORK_DAY_START_UTC_MS = 8 * 3600_000;

/** The work day ("YYYY-MM-DD") an instant falls in. */
export function workDayKey(iso: string): string {
  const d = safeDate(iso);
  return d ? new Date(d.getTime() - WORK_DAY_START_UTC_MS).toISOString().slice(0, 10) : '';
}

/** Today's work day. */
export function todayWorkDayKey(): string {
  return new Date(Date.now() - WORK_DAY_START_UTC_MS).toISOString().slice(0, 10);
}

/** "Mon, November 17, 2026" for a work-day key. */
export function workDayLong(key: string, fallback = 'Unknown date'): string {
  const [y, m, d] = String(key || '').split('-').map(Number);
  if (!y || !m || !d) return fallback;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'long', day: 'numeric',
  });
}
