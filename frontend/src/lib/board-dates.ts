/* Calendar maths for the board's date filter.
 *
 * Scheduled_at is stored as a UTC instant so that everyone sees the same moment in their own zone.
 * The date pickers, however, speak LOCAL calendar dates. Comparing the two directly is wrong by a day
 * near midnight — 08:00 Monday in GMT+9 is 23:00 SUNDAY in UTC, so a Monday-morning call would fall
 * outside a "this week" filter that starts on Monday. Everything here converts to the viewer's own
 * calendar date first.
 */

/** The calendar day an instant falls on, as YYYY-MM-DD, in `tz`. ('en-CA' renders exactly that shape,
 *  and it sorts correctly as a plain string, which is what the filter compares.) */
export function dateKeyIn(instant: string, tz?: string): string {
  const s = String(instant || '').trim();
  if (!s) return '';
  const t = new Date(s);
  if (isNaN(t.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(t);
  } catch {
    return s.slice(0, 10);        // unknown/invalid zone → fall back to the raw date
  }
}

/** Monday…Sunday of the week containing `now`, as YYYY-MM-DD in the viewer's zone. */
export function thisWeek(tz?: string, now: Date = new Date()): { from: string; to: string } {
  const today = dateKeyIn(now.toISOString(), tz);
  if (!today) return { from: '', to: '' };
  const [y, m, d] = today.split('-').map(Number);
  // Anchor in UTC purely as calendar arithmetic — the date is already the viewer's local one, so
  // using UTC here just stops the host machine's own zone from shifting it again.
  const anchor = new Date(Date.UTC(y, m - 1, d));
  const dow = (anchor.getUTCDay() + 6) % 7;               // Mon=0 … Sun=6
  const mon = new Date(anchor);
  mon.setUTCDate(anchor.getUTCDate() - dow);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  const key = (x: Date) => x.toISOString().slice(0, 10);
  return { from: key(mon), to: key(sun) };
}
