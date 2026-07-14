/* Caller availability, projected onto the viewer's calendar.
 *
 * The subtle part: a caller's working hours are stored as wall-clock times in THEIR OWN timezone
 * ("mon 09:00–18:00", Asia/Seoul), but the calendar is drawn in the VIEWER's timezone. A caller in
 * Los Angeles working 09:00–18:00 is 01:00–10:00 the NEXT DAY for an admin in Seoul — the band moves,
 * changes which weekday it belongs to, and can straddle midnight into two separate pieces.
 *
 * So we never compare wall clocks. We turn each of the caller's working windows into an absolute
 * instant range, clip it to the instant range of the viewer's day, and only then convert back to
 * offsets on the viewer's clock. Everything in between is UTC milliseconds, which has no opinion
 * about anybody's timezone.
 */

export type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
export type DayRule = { on: boolean; start: string; end: string };
/** As stored on the user: mon…sat (there is no Sunday — a caller is never available on Sunday). */
export type Availability = Partial<Record<DayKey, DayRule>>;

/** A meeting the caller has EVERY working day — a standup, a team sync.
 *
 * It sits inside the working window: they are at work, they simply cannot take a call then. So it is a
 * HOLE punched in their availability, not a change to their hours — which is why it has to be
 * subtracted after the window is computed, and why it can split one working day into two bands.
 * `days` empty means every day they work. Times are wall-clock in the CALLER's zone, like everything
 * else here. */
export type DailyMeeting = {
  on?: boolean; title?: string; start?: string; end?: string; days?: DayKey[];
};

/** A slice of availability on ONE viewer-local day, as WALL-CLOCK minutes (09:00 → 540).
 *
 * Wall clock, NOT elapsed time since midnight — the two differ by an hour after a DST shift, and the
 * calendar's hour rows are labelled with wall-clock hours. See minutesOfDay. */
export type Band = { startMin: number; endMin: number };
/** A meeting band knows WHICH meeting it is, so the grid can label it. */
export type MeetingBand = Band & { title: string };

export const DAY_MINUTES = 24 * 60;

const DAY_KEYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** The UTC offset of `tz` at a given instant, in ms. Derived by asking Intl what the wall clock reads
 *  there and diffing against the wall clock in UTC — the only way to get this without a tz library. */
function offsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - at.getTime();
}

/** A wall-clock time IN `tz` → the absolute instant it refers to.
 *
 * Iterative, because the offset we need depends on the instant we are trying to find. The first guess
 * uses the offset at the naive instant; if that lands on the far side of a DST switch, the offset there
 * differs and we re-solve with it.
 *
 * The two awkward days:
 *   FALL BACK — 01:30 happens twice. We return the FIRST occurrence, which is what a calendar shows.
 *   SPRING FORWARD — 02:30 never happens at all; the clock jumps 01:59:59 → 03:00:00. Naively re-solving
 *     lands *before* the gap (01:30), i.e. an hour EARLIER than asked for, which reads as the app losing
 *     an hour. Detect that the answer does not read back as the time requested and resolve FORWARD
 *     instead (02:30 → 03:30), the way every serious date library does. */
export function zonedToInstant(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = offsetMs(new Date(naive), tz);
  const guess1 = naive - o1;
  const o2 = offsetMs(new Date(guess1), tz);
  if (o2 === o1) return guess1;                      // no switch in between — done

  const guess2 = naive - o2;
  if (offsetMs(new Date(guess2), tz) === o2) return guess2;   // the re-solve is self-consistent → correct

  // Neither is self-consistent: the requested wall clock falls inside a spring-forward gap and simply
  // does not exist. guess1 is the one on the far side of the jump — take it, so we move forward.
  return guess1;
}

/** YYYY-MM-DD → [y, m, d]. */
function parseKey(key: string): [number, number, number] {
  const [y, m, d] = key.split('-').map(Number);
  return [y, m, d];
}

/** The calendar date in `tz` at a given instant, as YYYY-MM-DD. */
export function dateKeyAt(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts));
}

/** An instant → the wall clock a viewer in `tz` reads, as 'YYYY-MM-DDTHH:mm'.
 *
 * That is exactly what <input type="datetime-local"> speaks, and exactly what the board's
 * Scheduled_at cell sends: a NAIVE local time, which the server re-anchors to a UTC instant using the
 * editor's own timezone. So the round trip is symmetric — never hand this string back as if it were UTC. */
export function wallClockIn(ts: number, tz: string): string {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ts))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Midnight (00:00) of a YYYY-MM-DD in `tz`, as an instant. */
export function startOfDay(dateKey: string, tz: string): number {
  const [y, m, d] = parseKey(dateKey);
  return zonedToInstant(y, m, d, 0, 0, tz);
}

/** WHAT THE CLOCK ON THE WALL SAYS, in minutes: 09:00 → 540. In `tz`, for an instant.
 *
 * NOT `(ts - midnight) / 60000`. That is ELAPSED time, and on the two DST days a year it is not the
 * same number: a US "fall back" day is 25 hours long, so 14:00 is 900 elapsed minutes, not 840. The
 * calendar's rows are labelled with wall-clock hours, so anything that positions against those rows —
 * an event, an availability band, the now-line, a drag — must speak wall clock too, or everything on
 * a DST day is drawn (and booked) exactly one hour out. */
export function minutesOfDay(ts: number, tz: string): number {
  const hm = wallClockIn(ts, tz).slice(11);              // 'HH:mm'
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
}

/** The inverse: a wall-clock minute-of-day on a calendar date in `tz` → the absolute instant.
 *  This is what a drag must use to turn "the row I dropped on" into a Scheduled_at. */
export function instantAt(dateKey: string, minutes: number, tz: string): number {
  const [y, m, d] = parseKey(dateKey);
  const mins = Math.max(0, Math.min(DAY_MINUTES - 1, Math.round(minutes)));
  return zonedToInstant(y, m, d, Math.floor(mins / 60), mins % 60, tz);
}

/** The day `n` days after a YYYY-MM-DD, still YYYY-MM-DD. Pure calendar maths — no zone involved. */
export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = parseKey(dateKey);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** The weekday key of a YYYY-MM-DD. */
export function dayKeyOf(dateKey: string): DayKey {
  const [y, m, d] = parseKey(dateKey);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function hhmm(s: string): [number, number] {
  const [h, m] = String(s || '').split(':').map(Number);
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0];
}

/**
 * The caller's working hours that fall on ONE day of the viewer's calendar.
 *
 * @param dateKey  the viewer's calendar day, YYYY-MM-DD
 * @param viewerTz the zone the calendar is drawn in
 * @param av       the caller's availability (their own wall-clock hours)
 * @param callerTz the zone those hours are written in
 * @param daysOff  YYYY-MM-DD the caller cannot work, in THEIR OWN calendar
 *
 * Returns 0..n bands in minutes from the viewer's midnight. More than one is normal: a caller far
 * enough east or west can have two separate working windows land on a single day of your calendar.
 */
export function availabilityBands(
  dateKey: string,
  viewerTz: string,
  av: Availability | null | undefined,
  callerTz: string,
  daysOff: string[] = [],
): Band[] {
  if (!av || !viewerTz || !callerTz) return [];

  const dayStart = startOfDay(dateKey, viewerTz);
  const dayEnd = startOfDay(addDays(dateKey, 1), viewerTz);   // NOT +24h: a DST day is 23 or 25 hours
  const off = new Set(daysOff || []);

  // The caller's own date can be a day behind or ahead of ours, so consider the neighbours too —
  // this is what catches a working window that spills across the viewer's midnight.
  const centre = dateKeyAt(dayStart, callerTz);
  const candidates = new Set([addDays(centre, -1), centre, addDays(centre, 1)]);

  const bands: Band[] = [];
  for (const cDate of candidates) {
    if (off.has(cDate)) continue;                    // a day the caller cannot work
    const rule = av[dayKeyOf(cDate)];
    if (!rule || !rule.on) continue;                 // not a working day (Sunday is never in `av`)

    const [sh, sm] = hhmm(rule.start);
    const [eh, em] = hhmm(rule.end);
    const [y, m, d] = parseKey(cDate);
    const s = zonedToInstant(y, m, d, sh, sm, callerTz);
    const e = zonedToInstant(y, m, d, eh, em, callerTz);
    if (e <= s) continue;                            // malformed (end before start) — show nothing

    const lo = Math.max(s, dayStart);
    const hi = Math.min(e, dayEnd);
    if (hi <= lo) continue;                          // this window misses our day entirely

    // WALL-CLOCK minutes, to match the hour rows the band is painted behind. `hi === dayEnd` is the
    // one case wall clock cannot express: the instant the day ends reads 00:00 of the NEXT day, which
    // would collapse the band to zero height instead of running it to the bottom of the column.
    bands.push({
      startMin: minutesOfDay(lo, viewerTz),
      endMin: hi === dayEnd ? DAY_MINUTES : minutesOfDay(hi, viewerTz),
    });
  }

  return mergeBands(bands);
}

/** Union: overlapping or touching bands collapse into one, so the calendar paints a block, not seams.
 *  Also how a TEAM's availability is built — the times at least one member is free. */
export function mergeBands(bands: Band[]): Band[] {
  const sorted = [...bands].sort((a, b) => a.startMin - b.startMin);
  const merged: Band[] = [];
  for (const b of sorted) {
    const last = merged[merged.length - 1];
    if (last && b.startMin <= last.endMin) last.endMin = Math.max(last.endMin, b.endMin);
    else merged.push({ ...b });
  }
  return merged;
}

/** Does the daily meeting apply on this day of the CALLER's own calendar? */
function meetingRunsOn(cDate: string, av: Availability | null | undefined, dm: DailyMeeting | null | undefined,
                       daysOff: Set<string>): boolean {
  if (!dm?.on || daysOff.has(cDate)) return false;
  const dk = dayKeyOf(cDate);
  const rule = av?.[dk];
  if (!rule || !rule.on) return false;               // no meeting on a day they don't work at all
  const days = dm.days || [];
  return days.length === 0 || days.includes(dk);     // empty = every working day
}

/**
 * The caller's DAILY MEETING, on one day of the viewer's calendar.
 *
 * Same projection as availabilityBands — the meeting is written in the caller's wall clock, so for a
 * viewer in another zone it lands at a different hour and can even fall on a different day.
 */
export function meetingBands(
  dateKey: string,
  viewerTz: string,
  av: Availability | null | undefined,
  dms: DailyMeeting[] | null | undefined,
  callerTz: string,
  daysOff: string[] = [],
): MeetingBand[] {
  const list = (dms || []).filter((m) => m?.on);
  if (!list.length || !viewerTz || !callerTz) return [];

  const dayStart = startOfDay(dateKey, viewerTz);
  const dayEnd = startOfDay(addDays(dateKey, 1), viewerTz);
  const off = new Set(daysOff || []);
  const centre = dateKeyAt(dayStart, callerTz);
  const candidates = [addDays(centre, -1), centre, addDays(centre, 1)];

  const out: MeetingBand[] = [];
  for (const dm of list) {
    for (const cDate of candidates) {
      if (!meetingRunsOn(cDate, av, dm, off)) continue;
      const [sh, sm] = hhmm(dm.start || '');
      const [eh, em] = hhmm(dm.end || '');
      const [y, m, d] = parseKey(cDate);
      const s = zonedToInstant(y, m, d, sh, sm, callerTz);
      const e = zonedToInstant(y, m, d, eh, em, callerTz);
      if (e <= s) continue;

      const lo = Math.max(s, dayStart);
      const hi = Math.min(e, dayEnd);
      if (hi <= lo) continue;
      out.push({
        title: String(dm.title || '').trim() || 'Meeting',
        startMin: minutesOfDay(lo, viewerTz),
        endMin: hi === dayEnd ? DAY_MINUTES : minutesOfDay(hi, viewerTz),
      });
    }
  }
  // NOT merged: two meetings that touch stay two meetings, so each keeps its own label on the grid.
  return out.sort((a, b) => a.startMin - b.startMin);
}

/** Cut `holes` out of `bands`. A meeting in the middle of the day splits one working band into two. */
export function subtractBands(bands: Band[], holes: Band[]): Band[] {
  if (!holes.length) return bands;
  let cur = bands.map((b) => ({ ...b }));
  for (const h of holes) {
    const next: Band[] = [];
    for (const b of cur) {
      if (h.endMin <= b.startMin || h.startMin >= b.endMin) { next.push(b); continue; }   // no overlap
      if (h.startMin > b.startMin) next.push({ startMin: b.startMin, endMin: h.startMin });  // piece before
      if (h.endMin < b.endMin) next.push({ startMin: h.endMin, endMin: b.endMin });          // piece after
      // fully covered → the band disappears
    }
    cur = next;
  }
  return cur;
}

/** The caller's FREE time on one day of the viewer's calendar: working hours minus the daily meeting.
 *  This is what the calendar shades — being at work is not the same as being free to take a call. */
export function freeBands(
  dateKey: string,
  viewerTz: string,
  av: Availability | null | undefined,
  dms: DailyMeeting[] | null | undefined,
  callerTz: string,
  daysOff: string[] = [],
): Band[] {
  return subtractBands(
    availabilityBands(dateKey, viewerTz, av, callerTz, daysOff),
    meetingBands(dateKey, viewerTz, av, dms, callerTz, daysOff),
  );
}

/** Is the caller free to take a call at this exact instant?
 *  Used to flag a call booked outside their hours — or on top of their daily meeting. */
export function availableAt(
  instant: number,
  av: Availability | null | undefined,
  callerTz: string,
  daysOff: string[] = [],
  dms: DailyMeeting[] | null | undefined = null,
): boolean {
  if (!av || !callerTz) return true;                 // unknown → don't cry wolf
  const key = dateKeyAt(instant, callerTz);
  if ((daysOff || []).includes(key)) return false;
  const rule = av[dayKeyOf(key)];
  if (!rule || !rule.on) return false;
  const [y, m, d] = parseKey(key);
  const [sh, sm] = hhmm(rule.start);
  const [eh, em] = hhmm(rule.end);
  const s = zonedToInstant(y, m, d, sh, sm, callerTz);
  const e = zonedToInstant(y, m, d, eh, em, callerTz);
  if (instant < s || instant >= e) return false;     // outside the working window

  // At work, but in ANY ONE of their standing meetings — still not free to take a call.
  const off = new Set(daysOff || []);
  for (const dm of dms || []) {
    if (!meetingRunsOn(key, av, dm, off)) continue;
    const [mh, mm] = hhmm(dm.start || '');
    const [nh, nm] = hhmm(dm.end || '');
    const ms = zonedToInstant(y, m, d, mh, mm, callerTz);
    const me = zonedToInstant(y, m, d, nh, nm, callerTz);
    if (instant >= ms && instant < me) return false;
  }
  return true;
}
