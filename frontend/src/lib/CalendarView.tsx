/* Google-Calendar-style week view for the interviews board.
 *
 * Two thirds calendar, one third side panel (pick a caller → see their availability). The calendar is
 * the SAME data as the table — the same rows, the same live socket, the same filters — just drawn on a
 * time grid instead of in cells. Nothing here writes to the board except the two callbacks it is given.
 *
 * Timezone is the whole difficulty. Scheduled_at is a UTC instant; the grid is drawn in the VIEWER's
 * zone; a caller's working hours are wall-clock times in the CALLER's zone. All three are different.
 * Every placement therefore goes through absolute instants (see lib/availability), never wall clocks.
 */
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  addDays, availableAt, dateKeyAt, dayKeyOf, freeBands, instantAt, meetingBands, mergeBands,
  minutesOfDay, startOfDay, wallClockIn,
  type Availability, type Band, type DailyMeeting, type MeetingBand,
} from './availability';
import { effCol } from './board-cols';

export type CalOpt = { label: string; color?: string; kind?: 'team' | 'member'; group?: string };
export type CalCol = { id: string; name: string; type: string; options?: CalOpt[] };
export type CalRow = { id: string; cells: Record<string, any> };
export type CalPerson = {
  label: string; username: string; full_name: string;
  roles?: string[]; team_id?: string; avatar_url?: string;
  timezone?: string; availability?: Availability; days_off?: string[];
  daily_meetings?: DailyMeeting[];   // standups / syncs they have on their working days — not free then
  /** They have actually filled in their availability AND set a timezone. Without both, their hours are
   *  a fiction (the server invents a default week for everyone), so the calendar shows nothing at all
   *  rather than shading a schedule nobody agreed to. */
  availability_set?: boolean;
};

type Props = {
  rows: CalRow[];                       // rows this user may see, already passed through the non-date filters
  weekFrom: string;                     // Monday of the displayed week, YYYY-MM-DD
  onWeekChange: (mondayKey: string) => void;
  userTz: string;                       // the zone the grid is drawn in
  people: CalPerson[];
  teams: { id: string; name: string }[];   // a call can be handed to a TEAM, not just a person
  canSchedule: boolean;                 // may this user set Scheduled_at? (admins) → drag to book / move / resize
  /** Only an admin gets the caller search. Everyone else's rail is a short, fixed list — their team, or
   *  just themselves — so a "find a caller" box would only invite them to go looking for people who are
   *  not there, and are not theirs to look for. */
  canSearch: boolean;
  /** The caller PICKER is an assigning tool — choosing who takes a call, and comparing people's hours.
   *  Only an admin or a manager does that. A caller has nobody to pick: they get their own availability
   *  shaded automatically and their own upcoming calls, which is all the rail is for them. */
  showPicker: boolean;
  meLabel: string;                      // who is looking — used to shade THEIR hours when there is no picker
  columns: CalCol[];                    // the board's real columns (labels, types, select options)
  /** Fields this ROLE may not see at all (Creater, and Caller for a solo caller). NOT the table's
   *  hidden-column set — that one also lists fields which are shown inside another cell. */
  hideFields?: Set<string>;
  canEdit: (rowId: string, colId: string) => boolean;   // per-cell write permission, same rules as the table
  onOpenRow: (rowId: string) => void;
  onPatch: (rowId: string, colId: string, value: any) => void;
  onDelete?: (rowId: string) => void;   // admins only — the server refuses everyone else anyway
  /** Returns the new row's id, so the calendar can open its detail popup straight away — a slot you
   *  drag out is useless until it says WHO you are calling and about WHAT. */
  onCreateAt?: (isoInstant: string, minutes: number) => Promise<string | undefined> | void;
  onReschedule?: (rowId: string, isoInstant: string) => void;
  onResizeRow?: (rowId: string, minutes: number) => void;

  /* Per-cell soft locks — the same ones the table uses.
     Moving a call on the calendar IS an edit to Scheduled_at. Without claiming that cell, two admins
     could drag the same call at the same time and neither would see the other doing it; the loser's
     work would only be refused at the very end (the server 409s). Claiming makes it visible up front. */
  lockOf: (rowId: string, colId: string) => string | null;   // who else holds it, or null
  onClaim: (rowId: string, colId: string) => void;
  onRelease: () => void;
};

/** The cell a gesture actually edits — so the lock we claim is the one the server checks. */
const DRAG_COL = { move: 'c_sched', resize: 'c_min' } as const;

/* Everything about a call, in the popup, in this order.
   Left out on purpose: JD, Feedback and Resume are `button` columns that open their own modals in the
   table (a long thread and a file upload — the popup links across rather than being a worse version of
   them), Created_at is machine-written, and Team is not a field you set: picking a Caller from the tree
   already places the call with their team.

   Which of these a given person may SEE is not decided here — the board passes `hideFields` (Creater
   for everyone but an admin; Caller too for a solo caller). This popup used to render the list flat,
   so a caller could read the creator's name here even though the table hid the column. */
const DETAIL_FIELDS = [
  'c_index', 'c_sched', 'c_min', 'c_type',
  'c_company', 'c_title', 'c_account', 'c_client',
  'c_skill', 'c_salary', 'c_link',
  'c_caller', 'c_approved', 'c_status', 'c_creater',
];

const HOUR_PX = 44;                     // one hour of the day
const DAY_MIN = 24 * 60;
const LANE_GAP = 2;
const SNAP = 15;                        // drags land on quarter hours, like Google
const DRAG_PX = 4;                      // travel before a press counts as a drag rather than a click
const DEFAULT_MIN = 30;                 // a plain click (no drag) books half an hour
const snapTo = (m: number) => Math.round(m / SNAP) * SNAP;

/* One live drag. `moved` separates a real drag from a stray click, which is what lets a click still
   mean "book 30 minutes here" and "select this call" without either firing on the way out of a drag. */
type Drag =
  | { kind: 'create'; day: string; anchorMin: number; startMin: number; endMin: number; moved: boolean }
  | { kind: 'move'; id: string; day: string; startMin: number; endMin: number; grabMin: number; moved: boolean }
  | { kind: 'resize'; id: string; day: string; startMin: number; endMin: number; moved: boolean };

/* A stable colour per caller, so the same person is the same colour every week. Google gives each
   calendar a colour; here the caller IS the calendar. */
const PALETTE = [
  { bg: '#1e3a5f', bd: '#3b82f6', fg: '#bfdbfe' },
  { bg: '#14532d', bd: '#22c55e', fg: '#bbf7d0' },
  { bg: '#4c1d95', bd: '#a855f7', fg: '#e9d5ff' },
  { bg: '#7c2d12', bd: '#f97316', fg: '#fed7aa' },
  { bg: '#164e63', bd: '#06b6d4', fg: '#a5f3fc' },
  { bg: '#701a3f', bd: '#ec4899', fg: '#fbcfe8' },
  { bg: '#713f12', bd: '#eab308', fg: '#fef08a' },
];
const UNASSIGNED = { bg: '#2a2f3d', bd: '#6b7280', fg: '#d1d5db' };

function colourFor(name: string) {
  if (!name) return UNASSIGNED;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Who is this call with?
 *
 * A call can be handed to a TEAM with nobody picked yet — that is a real assignment, waiting on the
 * manager to choose someone. The board stores it in c_team with c_caller left empty. The table already
 * falls back to showing the Team when there is no person; the calendar did not, so a call assigned to a
 * team rendered as "Unassigned" and it looked as though the assignment had not saved. */
function assignmentOf(row: CalRow, find?: (who: string) => CalPerson | undefined):
    { caller: string; team: string; assignee: string; isTeam: boolean } {
  const raw = String(row.cells?.c_caller ?? '').trim();
  const team = String(row.cells?.c_team ?? '').trim();
  // The Caller cell may hold a USERNAME or a FULL NAME - the backend accepts either (see _caller_ids
  // and _resolve). Resolve to the person and use their display label as the one canonical key, or the
  // rail's counts and highlight silently miss every row that happens to store the other identity.
  const person = raw && find ? find(raw) : undefined;
  const caller = person ? person.label : raw;
  return { caller, team, assignee: caller || team, isTeam: !caller && !!team };
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (min: number) => `${pad(Math.floor(min / 60) % 24)}:${pad(Math.round(min) % 60)}`;

/* Where an instant sits on the grid, and where a grid position lands in time, are minutesOfDay() and
   instantAt() from ./availability. Both speak WALL CLOCK — the same thing the hour rows are labelled
   with. Using elapsed-time-since-midnight instead (ts - midnight) would agree on 363 days a year and
   be exactly one hour wrong on the other two, silently booking calls in the wrong hour. */

/** GMT+9 / GMT-7 — the same label the board's Scheduled_at column shows. */
function tzShort(tz: string): string {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
    return p?.value || '';
  } catch { return ''; }
}

type Ev = {
  row: CalRow; id: string; ts: number;
  startMin: number;
  endMin: number;      // clipped to midnight — for DRAWING only
  durMin: number;      // the call's REAL length. A resize must start from this, or grabbing the grip
                       // of a call that runs past midnight would silently truncate it to the clip.
  caller: string;      // the PERSON, if one is named
  team: string;        // the TEAM it was handed to (a call can go to a team with nobody picked yet)
  assignee: string;    // who it is actually with: the person, else the team
  isTeam: boolean;     // handed to a team, nobody picked yet — the manager still has to choose
  title: string;
  lane: number; lanes: number;
};

/** Lay overlapping calls out side by side, the way a calendar does — otherwise two calls at the same
 *  hour sit exactly on top of each other and one is invisible. */
function packLanes(evs: Ev[]): void {
  const sorted = [...evs].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  let cluster: Ev[] = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const lanes: number[] = [];                       // lane index → end minute of its last event
    for (const e of cluster) {
      let l = lanes.findIndex((end) => end <= e.startMin);
      if (l < 0) { l = lanes.length; lanes.push(0); }
      lanes[l] = e.endMin;
      e.lane = l;
    }
    const n = lanes.length;
    cluster.forEach((e) => { e.lanes = n; });
    cluster = [];
  };
  for (const e of sorted) {
    if (cluster.length && e.startMin >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.endMin);
  }
  flush();
}

export default function CalendarView(props: Props) {
  const { rows, weekFrom, onWeekChange, userTz, people, teams, canSchedule, canSearch, showPicker, meLabel,
          columns, hideFields, canEdit, onOpenRow, onPatch, onDelete, onCreateAt, onReschedule, onResizeRow,
          lockOf, onClaim, onRelease } = props;
  const [detailId, setDetailId] = useState<string>('');
  // Re-read the row from `rows` every render, so a live edit by somebody else updates the open popup
  // instead of leaving you staring at a stale copy you are about to save over.
  const detailRow = detailId ? rows.find((r) => r.id === detailId) : undefined;
  useEffect(() => { if (detailId && !detailRow) setDetailId(''); }, [detailId, detailRow]);   // deleted out from under us
  // Remembered, because this component unmounts every time you flip to the table — without this,
  // stepping over to check a row and coming back silently drops the caller you were looking at.
  const [selCaller, setSelCaller] = useState<string>(() => localStorage.getItem('iv.cal.caller') || '');
  useEffect(() => { localStorage.setItem('iv.cal.caller', selCaller); }, [selCaller]);
  const [selRow, setSelRow] = useState<string>('');
  const [q, setQ] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {                                            // the red "now" line, like Google's
    const t = window.setInterval(() => setNowTs(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // Open on the working day, not on midnight — 24 hours of empty night is not what you came to see.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 7.5 * HOUR_PX;
  }, []);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekFrom, i)), [weekFrom]);
  const todayKey = dateKeyAt(nowTs, userTz);

  // Only people you could actually book, and only those who have SET UP their availability + timezone.
  // Someone who has never opened the Account page has nothing to shade — listing them just invites you
  // to click a name and be shown an invented week (or an empty one that reads as "never works").
  const configured = (p: CalPerson) => !!p.availability_set && !!p.availability && !!p.timezone;
  const bookable = useMemo(() => people
    .filter((p) => (p.roles || []).some((r) => r === 'caller' || r === 'manager'))
    .sort((a, b) => a.label.localeCompare(b.label)), [people]);
  const callers = useMemo(() => bookable.filter(configured), [bookable]);
  const byLabel = useMemo(() => {
    const m: Record<string, CalPerson> = {};
    for (const p of bookable) { m[p.label] = p; if (p.username) m[p.username] = p; }
    return m;
  }, [bookable]);
  // With no picker, the "selection" is simply YOU — your hours are shaded and nothing is filtered out.
  const shadeKey = showPicker ? selCaller : meLabel;
  const sel = shadeKey ? byLabel[shadeKey] : undefined;                   // a PERSON, if one is picked
  const selTeam = showPicker && selCaller ? teams.find((t) => t.name === selCaller) : undefined;   // ...or a TEAM
  const teamMembers = (tid: string) => people.filter((x) => String(x.team_id || '').trim() === tid);

  // Folded teams. Remembered, so the rail looks the same when you come back to it.
  const [folded, setFolded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('iv.cal.folded') || '[]')); }
    catch { return new Set(); }
  });
  useEffect(() => { localStorage.setItem('iv.cal.folded', JSON.stringify([...folded])); }, [folded]);
  const toggleFold = (id: string) => setFolded((f) => {
    const n = new Set(f);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const whoOf = (r: CalRow) => assignmentOf(r, (w) => byLabel[w]).assignee;
  const countPerson = (label: string) => rows.filter((r) => whoOf(r) === label).length;
  /** A team's calls are the ones handed to the TEAM plus the ones any of its members hold — that is
   *  the team's schedule, which is what the number next to a team should mean. */
  const teamLabels = (tid: string) => new Set(teamMembers(tid).map((m) => m.label));
  const countTeam = (t: { id: string; name: string }) => {
    const mine = teamLabels(t.id);
    return rows.filter((r) => { const a = whoOf(r); return a === t.name || mine.has(a); }).length;
  };
  /** Selecting a TEAM highlights everything the team is on, not only the calls with no caller picked —
   *  otherwise the number beside it and the calls it lights up would disagree. */
  const selMembers = selTeam ? teamLabels(selTeam.id) : null;
  const inSelection = (assignee: string): boolean => {
    if (!showPicker || !selCaller) return true;      // nothing was picked -> nothing is dimmed
    if (selTeam) return assignee === selTeam.name || !!selMembers?.has(assignee);
    return assignee === selCaller;
  };

  // ── events for the visible week ────────────────────────────────────────────
  const weekStart = startOfDay(weekFrom, userTz);
  const weekEnd = startOfDay(addDays(weekFrom, 7), userTz);

  const { byDay, unscheduled, offWeek } = useMemo(() => {
    const byDay: Record<string, Ev[]> = {};
    days.forEach((d) => { byDay[d] = []; });
    const unscheduled: CalRow[] = [];
    let offWeek = 0;

    for (const row of rows) {
      const raw = String(row.cells?.c_sched ?? '').trim();
      if (!raw) { unscheduled.push(row); continue; }
      const ts = new Date(raw).getTime();
      if (isNaN(ts)) { unscheduled.push(row); continue; }
      if (ts < weekStart || ts >= weekEnd) { offWeek++; continue; }

      const key = dateKeyAt(ts, userTz);
      if (!byDay[key]) continue;                       // paranoia: outside the seven columns
      const dur = Math.max(15, Number(row.cells?.c_min) || 30);
      const startMin = minutesOfDay(ts, userTz);
      byDay[key].push({
        row, id: row.id, ts,
        startMin,
        endMin: Math.min(DAY_MIN, startMin + dur),     // a call running past midnight is clipped, not wrapped
        durMin: dur,
        ...assignmentOf(row, (who) => byLabel[who]),
        title: String(row.cells?.c_company || row.cells?.c_title || row.cells?.c_index || 'Interview').trim(),
        lane: 0, lanes: 1,
      });
    }
    Object.values(byDay).forEach(packLanes);
    return { byDay, unscheduled, offWeek };
  }, [rows, days, weekStart, weekEnd, userTz, byLabel]);   // byLabel: people load async — re-resolve when they arrive

  // ── the selected caller's working hours, projected onto each column ─────────
  // What the grid shades is FREE time, not "at work": the daily meeting is cut out of it, because
  // being at their desk and being able to take a call are different things. The meeting itself is
  // drawn on top, so you can see WHY the gap is there rather than just finding a hole.
  const { bands, meetings } = useMemo(() => {
    const bands: Record<string, Band[]> = {};
    const meetings: Record<string, MeetingBand[]> = {};

    // A TEAM: shade when AT LEAST ONE member is free — "could anybody here take this call?". A union,
    // not an intersection: you only need one of them. Their standups are personal, so none are drawn.
    if (selTeam) {
      const mem = teamMembers(selTeam.id).filter(configured);
      for (const d of days) {
        bands[d] = mergeBands(mem.flatMap((m) =>
          freeBands(d, userTz, m.availability, m.daily_meetings, m.timezone || userTz, m.days_off || [])));
        meetings[d] = [];
      }
      return { bands, meetings };
    }

    if (!sel || !configured(sel)) return { bands, meetings };
    const ctz = sel.timezone!;
    const dms = sel.daily_meetings;
    for (const d of days) {
      bands[d] = freeBands(d, userTz, sel.availability, dms, ctz, sel.days_off || []);
      meetings[d] = meetingBands(d, userTz, sel.availability, dms, ctz, sel.days_off || []);
    }
    return { bands, meetings };
  }, [sel, selTeam, people, days, userTz]);

  const monthLabel = useMemo(() => {
    const a = new Date(`${weekFrom}T00:00:00Z`);
    const b = new Date(`${addDays(weekFrom, 6)}T00:00:00Z`);
    const f = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...o, timeZone: 'UTC' }).format(d);
    return f(a, { month: 'short' }) === f(b, { month: 'short' })
      ? `${f(a, { month: 'long' })} ${f(a, { year: 'numeric' })}`
      : `${f(a, { month: 'short' })} – ${f(b, { month: 'short' })} ${f(b, { year: 'numeric' })}`;
  }, [weekFrom]);

  const goToday = () => {
    const k = dateKeyAt(Date.now(), userTz);
    const dow = (new Date(`${k}T00:00:00Z`).getUTCDay() + 6) % 7;   // Mon=0
    onWeekChange(addDays(k, -dow));
  };

  const nowMin = minutesOfDay(nowTs, userTz);
  const shownCallers = q
    ? callers.filter((c) => c.label.toLowerCase().includes(q.trim().toLowerCase()))
    : callers;
  const shownTeams = q
    ? teams.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase()))
    : teams;

  // The rail's two halves: callers who belong to nobody, and each team with its own people under it.
  // A team-mate must NOT also appear in the individual list — that is the flat-list confusion this
  // replaces, where Ayesha (no team) sat between two members of somebody else's team.
  const solo = shownCallers.filter((p) => !String(p.team_id || '').trim());
  const grouped = shownTeams
    .map((team) => ({ team, members: shownCallers.filter((p) => String(p.team_id || '').trim() === team.id) }))
    // when SEARCHING, keep a team whose name matched even if none of its members did
    .filter(({ team, members }) => members.length > 0 || !q || team.name.toLowerCase().includes(q.trim().toLowerCase()));

  /** One person in the rail. `nested` = they sit under their team. */
  const personRow = (p: CalPerson, nested: boolean) => {
    const c = colourFor(p.label);
    const n = countPerson(p.label);
    return (
      <button key={p.username || p.label} type="button"
        className={'cal-person' + (nested ? ' cal-person--nested' : '')
                   + (selCaller === p.label ? ' cal-person--on' : '')}
        title={`Shade only ${p.label}'s hours`}
        onClick={() => setSelCaller(selCaller === p.label ? '' : p.label)}>
        <span className="cal-swatch" style={{ background: c.bd }} />
        <span className="cal-person-n">{p.label}</span>
        {p.timezone && <span className="cal-person-tz">{tzShort(p.timezone) || p.timezone}</span>}
        {n > 0 && <span className="cal-person-n2">{n}</span>}
      </button>
    );
  };

  /* ── dragging ────────────────────────────────────────────────────────────────
     Press and drag on empty grid to draw a call of whatever length you sweep out; drag a call to move
     it (to another day too); drag its bottom edge to change its duration. A press that never moves is
     still a click — booking the default half hour, or just selecting the call you pressed on.

     Listeners go on the DOCUMENT, not the column: once the button is down the pointer routinely leaves
     the element it started in (that is the entire point of a drag), and a column-scoped mousemove would
     simply stop firing the moment you crossed into the next day. */
  const colEls = useRef<Record<string, HTMLDivElement | null>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);   // where the press began (drag threshold)
  const inGrid = useRef(true);                                    // is the pointer still over the calendar?
  const clickGuard = useRef(false);                               // a finished drag must not also fire a click
  const put = (d: Drag | null) => { dragRef.current = d; setDrag(d); };

  // Props/derived values the document listeners need, kept fresh without re-binding mid-drag.
  const live = useRef({ days, userTz, onCreateAt, onReschedule, onResizeRow });
  live.current = { days, userTz, onCreateAt, onReschedule, onResizeRow };

  /** Which day column, and which WALL-CLOCK minute of it, is the pointer over?
   *  `inside` says whether it is actually over the calendar — a release outside means "cancel". */
  const slotAt = (clientX: number, clientY: number): { day: string; min: number; inside: boolean } | null => {
    const ds = live.current.days;
    // Measure against the SCROLL VIEWPORT (.cal-body), not the grid canvas inside it. The canvas is a
    // full 24 hours tall, so when the calendar is scrolled its bounding box reaches far above and below
    // what anyone can see — testing against it, a pointer up on the page header still counted as
    // "inside the calendar", and letting go there committed the drag instead of cancelling it.
    const g = bodyRef.current?.getBoundingClientRect();
    const inside = !!g && clientX >= g.left && clientX <= g.right && clientY >= g.top && clientY <= g.bottom;

    let day = '';
    for (const d of ds) {
      const r = colEls.current[d]?.getBoundingClientRect();
      if (r && clientX >= r.left && clientX < r.right) { day = d; break; }
    }
    if (!day) {                                 // off the sides - keep tracking against the end column
      const first = colEls.current[ds[0]]?.getBoundingClientRect();
      const last = colEls.current[ds[ds.length - 1]]?.getBoundingClientRect();
      if (first && clientX < first.left) day = ds[0];
      else if (last && clientX >= last.right) day = ds[ds.length - 1];
      else return null;
    }
    const r = colEls.current[day]!.getBoundingClientRect();
    return { day, min: Math.max(0, Math.min(DAY_MIN, ((clientY - r.top) / HOUR_PX) * 60)), inside };
  };

  // EVERY way a drag can end goes through here — mouseup, Escape, right-click, losing focus. So this is
  // the one place the cell has to be handed back. Release anywhere else and a path that skipped it would
  // leave the call locked to you on everyone else's board until the lock aged out.
  const cancelDrag = () => {
    put(null);
    downAt.current = null;
    document.body.classList.remove('cal-dragging');
    onRelease();
  };

  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('cal-dragging');

    const onMove = (e: MouseEvent) => {
      // The button came up somewhere we never saw it (alt-tab, the OS stole capture, a context menu ate
      // the mouseup). Without this the drag stays armed forever, and the NEXT click anywhere on the page
      // would land as a reschedule.
      if (e.buttons === 0) { cancelDrag(); return; }

      const cur = dragRef.current;
      const s = cur && slotAt(e.clientX, e.clientY);
      if (!cur || !s) return;
      inGrid.current = s.inside;

      // A press is not a drag until the pointer has actually travelled. Without this, one pixel of jitter
      // while clicking a call that starts at 09:10 snaps it to 09:15 and silently reschedules it.
      const far = !!downAt.current
        && Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) >= DRAG_PX;
      if (!far && !cur.moved) return;

      if (cur.kind === 'create') {
        const b = snapTo(s.min);
        const lo = Math.min(cur.anchorMin, b);
        const hi = Math.max(cur.anchorMin, b);
        // Sweeping upwards is a real gesture - normalise it rather than rendering an inverted box.
        put({ ...cur, startMin: lo, endMin: Math.max(lo + SNAP, hi), moved: true });
      } else if (cur.kind === 'move') {
        const dur = cur.endMin - cur.startMin;
        const st = Math.max(0, Math.min(DAY_MIN - dur, snapTo(s.min - cur.grabMin)));
        put({ ...cur, day: s.day, startMin: st, endMin: st + dur, moved: true });
      } else {
        const en = Math.max(cur.startMin + SNAP, Math.min(DAY_MIN, snapTo(s.min)));
        put({ ...cur, endMin: en, moved: true });
      }
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const cur = dragRef.current;
      const outside = !inGrid.current;
      cancelDrag();
      if (!cur) return;

      // Dragged off the calendar and let go = "no, forget it". Committing here instead would clamp the
      // pointer back to an edge column and book the call somewhere the user never pointed at.
      if (outside) return;

      const { userTz: tz, onCreateAt: create, onReschedule: move, onResizeRow: resize } = live.current;
      const at = (day: string, min: number) => new Date(instantAt(day, min, tz)).toISOString();

      if (cur.kind === 'create') {
        // Book the slot, then open it — the time is only half the booking. Straight into the popup so
        // the company, position and caller get filled in while you are still thinking about them,
        // instead of leaving an untitled box on the calendar for someone to puzzle over later.
        const made = create?.(at(cur.day, cur.startMin), cur.moved ? cur.endMin - cur.startMin : DEFAULT_MIN);
        if (made && typeof (made as Promise<string | undefined>).then === 'function') {
          void (made as Promise<string | undefined>).then((id) => { if (id) setDetailId(id); });
        }
      } else if (!cur.moved) {
        setSelRow(cur.id);                      // pressed a call but never dragged -> just select it
      } else {
        clickGuard.current = true;              // swallow the click this mouseup is about to produce
        if (cur.kind === 'move') move?.(cur.id, at(cur.day, cur.startMin));
        else resize?.(cur.id, cur.endMin - cur.startMin);
      }
    };

    // Every way a drag can legitimately be abandoned. Escape is the one people reach for; the other two
    // are how the browser takes the mouse away from us without ever sending a mouseup.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelDrag(); };
    const onBlur = () => cancelDrag();
    const onCtx = () => cancelDrag();

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKey);
    document.addEventListener('contextmenu', onCtx);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('contextmenu', onCtx);
      window.removeEventListener('blur', onBlur);
      document.body.classList.remove('cal-dragging');
    };
  }, [dragging]);

  const begin = (d: Drag, e: React.MouseEvent) => {
    downAt.current = { x: e.clientX, y: e.clientY };
    inGrid.current = true;
    put(d);
  };

  const startCreate = (day: string, e: React.MouseEvent<HTMLDivElement>) => {
    if (!canSchedule || !onCreateAt || e.button !== 0) return;
    if (e.detail > 1) return;          // the 2nd press of a double-click - one gesture must not book twice
    const s = slotAt(e.clientX, e.clientY);
    if (!s) return;
    e.preventDefault();                // or the browser starts a text selection instead
    const a = snapTo(s.min);
    begin({ kind: 'create', day, anchorMin: a, startMin: a, endMin: a + SNAP, moved: false }, e);
  };

  const startMove = (ev: Ev, day: string, e: React.MouseEvent) => {
    if (!canSchedule || !onReschedule || e.button !== 0) return;
    if (lockOf(ev.id, DRAG_COL.move)) return;          // somebody else is already moving this call
    const s = slotAt(e.clientX, e.clientY);
    if (!s) return;
    onClaim(ev.id, DRAG_COL.move);                     // tell every other board, before the first pixel
    e.preventDefault(); e.stopPropagation();    // do not also begin drawing a new call underneath
    begin({ kind: 'move', id: ev.id, day, startMin: ev.startMin, endMin: ev.endMin,
            grabMin: s.min - ev.startMin, moved: false }, e);
  };

  const startResize = (ev: Ev, day: string, e: React.MouseEvent) => {
    if (!canSchedule || !onResizeRow || e.button !== 0) return;
    if (lockOf(ev.id, DRAG_COL.resize)) return;
    e.preventDefault(); e.stopPropagation();
    onClaim(ev.id, DRAG_COL.resize);
    // Seed from the TRUE length, not the midnight-clipped one, so merely grabbing the grip of a call
    // that runs past midnight cannot shorten it.
    begin({ kind: 'resize', id: ev.id, day, startMin: ev.startMin,
            endMin: ev.startMin + ev.durMin, moved: false }, e);
  };

  return (
    <div className="cal-wrap">
      {/* ── 2/3: the calendar ───────────────────────────────────────────────── */}
      <section className="cal-main">
        <header className="cal-head">
          <div className="cal-nav">
            <button className="ghost" title="Previous week" onClick={() => onWeekChange(addDays(weekFrom, -7))}>‹</button>
            <button className="ghost" title="Next week" onClick={() => onWeekChange(addDays(weekFrom, 7))}>›</button>
            <button className="secondary cal-today" onClick={goToday}>Today</button>
          </div>
          <h3 className="cal-month">{monthLabel}</h3>
          <span className="muted cal-tz">Times in {tzShort(userTz) || userTz}</span>
        </header>

        <div className="cal-days">
          <div className="cal-gutter-head" />
          {days.map((d) => {
            const dt = new Date(`${d}T00:00:00Z`);
            const dow = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(dt);
            const isToday = d === todayKey;
            return (
              <div key={d} className={'cal-dayhead' + (isToday ? ' cal-dayhead--today' : '')}>
                <span className="cal-dow">{dow}</span>
                <span className="cal-dnum">{dt.getUTCDate()}</span>
              </div>
            );
          })}
        </div>

        <div className="cal-body" ref={bodyRef}>
          <div className="cal-grid" style={{ height: 24 * HOUR_PX }}>
            <div className="cal-gutter">
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="cal-hour-lbl" style={{ top: h * HOUR_PX }}>{h === 0 ? '' : `${pad(h)}:00`}</div>
              ))}
            </div>

            {days.map((d) => {
              const evs = byDay[d] || [];
              const isToday = d === todayKey;
              return (
                <div key={d} ref={(el) => { colEls.current[d] = el; }}
                     className={'cal-col' + (canSchedule ? ' cal-col--bookable' : '')}
                     onMouseDown={(e) => startCreate(d, e)}>
                  {/* hour lines */}
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="cal-hline" style={{ top: h * HOUR_PX }} />
                  ))}

                  {/* the selected caller's working hours, behind everything */}
                  {(bands[d] || []).map((b, i) => (
                    <div key={i} className="cal-avail"
                         style={{ top: (b.startMin / 60) * HOUR_PX, height: ((b.endMin - b.startMin) / 60) * HOUR_PX }}
                         title={`${sel?.label} is free ${hhmm(b.startMin)}–${hhmm(b.endMin)} your time`} />
                  ))}

                  {/* Their standup / daily sync. They ARE at work — they just cannot take a call. */}
                  {(meetings[d] || []).map((b, i) => (
                    <div key={`m${i}`} className="cal-meeting"
                         style={{ top: (b.startMin / 60) * HOUR_PX, height: ((b.endMin - b.startMin) / 60) * HOUR_PX }}
                         title={`${sel?.label}: ${b.title} ${hhmm(b.startMin)}–${hhmm(b.endMin)} your time`}>
                      <span className="cal-meeting-l">{b.title}</span>
                    </div>
                  ))}

                  {/* the red "now" line */}
                  {isToday && (
                    <div className="cal-now" style={{ top: (nowMin / 60) * HOUR_PX }}>
                      <span className="cal-now-dot" />
                    </div>
                  )}

                  {evs.map((ev) => {
                    // While this call is being dragged, the ghost below shows where it will land — so
                    // hide the real one rather than leaving a copy behind at the old time.
                    const beingDragged = drag && drag.kind !== 'create' && drag.id === ev.id;
                    // Somebody ELSE has this call open — moving it, resizing it, or editing it in the
                    // popup. Say who, and make it inert: the server would refuse our write anyway (409),
                    // so refusing it here saves the effort and, more importantly, makes it VISIBLE that
                    // the call is in motion instead of silently jumping under our cursor.
                    const heldBy = lockOf(ev.id, DRAG_COL.move) || lockOf(ev.id, DRAG_COL.resize)
                                || lockOf(ev.id, 'c_company') || lockOf(ev.id, 'c_caller');
                    const c = colourFor(ev.assignee);
                    const dimmed = showPicker && !!selCaller && !inSelection(ev.assignee);
                    const past = ev.ts < nowTs;
                    // A call booked outside the caller's hours is a real scheduling mistake — flag it.
                    const p = byLabel[ev.caller];
                    const outside = !!ev.caller && !!p?.availability
                      && !availableAt(ev.ts, p.availability, p.timezone || userTz, p.days_off || [], p.daily_meetings);
                    const w = 100 / ev.lanes;
                    const style: CSSProperties = {
                      top: (ev.startMin / 60) * HOUR_PX,
                      height: Math.max(20, ((ev.endMin - ev.startMin) / 60) * HOUR_PX - LANE_GAP),
                      left: `calc(${ev.lane * w}% + 2px)`,
                      width: `calc(${w}% - 4px)`,
                      background: c.bg, borderLeft: `3px solid ${c.bd}`, color: c.fg,
                      ...(beingDragged ? { opacity: 0.25 } : null),
                    };
                    return (
                      <button key={ev.id} type="button"
                        className={'cal-ev' + (dimmed ? ' cal-ev--dim' : '') + (past ? ' cal-ev--past' : '')
                                   + (selRow === ev.id ? ' cal-ev--sel' : '')
                                   + (heldBy ? ' cal-ev--held' : canSchedule ? ' cal-ev--draggable' : '')}
                        style={style}
                        title={`${hhmm(ev.startMin)}–${hhmm(ev.endMin)} · ${ev.title}${ev.caller ? ` · ${ev.caller}` : ' · unassigned'}`
                               + (outside ? '\n⚠ outside this caller\'s working hours' : '')
                               + (heldBy ? `\n✎ ${heldBy} is working on this right now — you cannot move it`
                                         : canSchedule ? '\nDrag to move · drag the bottom edge to resize · double-click to open' : '')}
                        onMouseDown={(e) => startMove(ev, d, e)}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (clickGuard.current) { clickGuard.current = false; return; }   // this click is a drag's tail
                          setSelRow(ev.id);
                        }}
                        onDoubleClick={(e) => { e.stopPropagation(); setDetailId(ev.id); }}>
                        <span className="cal-ev-t">{hhmm(ev.startMin)}{outside && <span className="cal-warn" title="Outside working hours"> ⚠</span>}</span>
                        <span className="cal-ev-n">{ev.title}</span>
                        {ev.assignee
                          ? <span className={'cal-ev-c' + (ev.isTeam ? ' cal-ev-c--team' : '')}>{ev.isTeam ? `\u{1F465} ${ev.team}` : ev.caller}</span>
                          : <span className="cal-ev-c cal-ev-c--none">Unassigned</span>}
                        {heldBy && <span className="cal-ev-held" title={`${heldBy} is working on this right now`}>✎ {heldBy}</span>}
                        {canSchedule && !heldBy && <span className="cal-ev-grip" onMouseDown={(e) => startResize(ev, d, e)} title="Drag to change how long the call is" />}
                      </button>
                    );
                  })}

                  {/* The drag itself: what you are drawing, or where the call you are holding will land. */}
                  {drag && drag.day === d && (
                    <div className="cal-draft"
                         style={{ top: (drag.startMin / 60) * HOUR_PX,
                                  height: Math.max(16, ((drag.endMin - drag.startMin) / 60) * HOUR_PX - LANE_GAP) }}>
                      <span className="cal-draft-t">{hhmm(drag.startMin)} – {hhmm(drag.endMin)}</span>
                      <span className="cal-draft-d">{drag.endMin - drag.startMin} min</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── 1/3: pick a caller, see when they can work ──────────────────────── */}
      <aside className="cal-side">
        {showPicker && (
        <div className="cal-side-sec cal-side-sec--callers">
          <h4 className="cal-side-h">Caller</h4>
          {canSearch && (
            <input className="cal-search" placeholder="Find a caller…" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          {/* Everyone -> the callers who belong to no team -> each team, with its members nested.
              The same shape as the board's own Caller dropdown, so the two views read alike. */}
          <div className="cal-people">
            {/* "Everyone" only makes sense when there IS everyone. On your own board it is the only
                option there could be, so it is just noise. */}
            {(bookable.length + teams.length) > 1 && (
              <button type="button" className={'cal-person' + (!selCaller ? ' cal-person--on' : '')}
                      onClick={() => setSelCaller('')}>
                <span className="cal-swatch" style={{ background: UNASSIGNED.bd }} />
                <span className="cal-person-n">Everyone</span>
                {rows.length > 0 && <span className="cal-person-n2">{rows.length}</span>}
              </button>
            )}
          </div>

          {solo.length > 0 && (
            <>
              <h4 className="cal-side-h cal-side-h--sub">Individual</h4>
              <div className="cal-people">
                {solo.map((p) => personRow(p, false))}
              </div>
            </>
          )}

          {grouped.length > 0 && (
            <>
              <h4 className="cal-side-h cal-side-h--sub">Teams</h4>
              <div className="cal-people">
                {grouped.map(({ team, members }) => {
                  const c = colourFor(team.name);
                  const n = countTeam(team);
                  const shut = folded.has(team.id);
                  return (
                    <div key={team.id} className="cal-team">
                      <div className="cal-team-hd">
                        <button type="button" className="cal-fold" aria-expanded={!shut}
                          title={shut ? 'Show members' : 'Hide members'}
                          onClick={() => toggleFold(team.id)}>{shut ? '\u25b8' : '\u25be'}</button>
                        <button type="button"
                          className={'cal-person cal-person--team' + (selCaller === team.name ? ' cal-person--on' : '')}
                          title={`Shade when ANY member of ${team.name} is free`}
                          onClick={() => setSelCaller(selCaller === team.name ? '' : team.name)}>
                          <span className="cal-swatch" style={{ background: c.bd }} />
                          <span className="cal-person-n">👥 {team.name}</span>
                          {n > 0 && <span className="cal-person-n2">{n}</span>}
                        </button>
                      </div>
                      {!shut && members.map((m) => personRow(m, true))}
                      {!shut && !members.length && (
                        <p className="muted cal-empty cal-person--nested">No member here has set their availability.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {!shownCallers.length && !shownTeams.length && !!q && (
            <p className="muted cal-empty">No caller or team matches “{q}”.</p>
          )}
          {!shownCallers.length && !q && (
            <p className="muted cal-empty">
              {bookable.length
                ? 'Nobody here has set their availability and time zone yet.'
                : 'No callers to show.'}
            </p>
          )}
        </div>

        )}

        <div className="cal-side-sec">
          <h4 className="cal-side-h">{showPicker ? 'Availability' : 'Your availability'}</h4>
          {!sel && !selTeam && (
            <p className="muted cal-empty">
              {showPicker
                ? 'Pick a caller to shade their working hours onto the week.'
                : 'Set your working hours on the Availability page and they will be shaded here.'}
            </p>
          )}
          {/* You can see this person's CALLS but not their ROSTER — the server withheld it (a caller
              may not read a team-mate's working hours or holidays). Say so, instead of showing an empty
              week that reads as "they never work". */}
          {sel && !sel.availability && (
            <p className="muted cal-empty">
              You can see <b>{sel.label}</b>’s calls, but not their working hours — only a manager or an
              admin can see the team’s roster.
            </p>
          )}
          {selTeam && (() => {
            // Only members who HAVE working hours. Someone who never filled the form in has nothing to
            // contribute to the shading and nothing to show if you clicked them, so they are not listed
            // at all — the rail is a list of people you can schedule against, not a staff directory.
            const ready = teamMembers(selTeam.id).filter(configured);
            const days7 = Array.from({ length: 7 }, (_, i) => addDays(weekFrom, i));
            const total = days7.reduce((s, d) => s + (bands[d] || []).reduce((t, b) => t + (b.endMin - b.startMin), 0), 0);
            return (
              <div className="cal-av">
                {/* A UNION, not an intersection. You need ONE of them to be free, not all of them — so
                    the shading answers "could anybody on this team take a call then?". Their standups
                    are personal, so none are drawn: another member is still free. */}
                <p className="cal-av-tz">
                  {ready.length
                    ? <>Shaded = when <b>at least one</b> of {selTeam.name}’s {ready.length}{' '}
                        member{ready.length === 1 ? '' : 's'} is free, in <b>{tzShort(userTz) || userTz}</b>,
                        your time. {Math.round(total / 60)}h this week.</>
                    : <span className="cal-av-warn">Nobody on {selTeam.name} has set their availability yet.</span>}
                </p>
                <div className="cal-people">
                  {ready.map((m) => (
                    <button key={m.username || m.label} type="button" className="cal-person"
                      title={`See only ${m.label}’s hours`}
                      onClick={() => setSelCaller(m.label)}>
                      <span className="cal-swatch" style={{ background: colourFor(m.label).bd }} />
                      <span className="cal-person-n">{m.label}</span>
                      <span className="cal-person-n2">{tzShort(m.timezone || '') || m.timezone}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
          {sel && sel.availability && <Availability_ p={sel} viewerTz={userTz} weekFrom={weekFrom} bands={bands} />}
        </div>

        {(unscheduled.length > 0 || offWeek > 0) && (
          <div className="cal-side-sec">
            <h4 className="cal-side-h">Not on this week</h4>
            {offWeek > 0 && <p className="muted cal-empty">{offWeek} call{offWeek === 1 ? '' : 's'} in other weeks.</p>}
            {unscheduled.length > 0 && (
              <>
                {/* Unscheduled calls have no time, so they cannot be drawn on a time grid — but they must
                    not silently vanish just because you switched to the calendar. */}
                <p className="muted cal-empty">{unscheduled.length} not scheduled yet:</p>
                <div className="cal-unsched">
                  {unscheduled.slice(0, 12).map((r) => (
                    <button key={r.id} type="button" className="cal-unsched-i" onDoubleClick={() => setDetailId(r.id)}
                            title="Double-click to open its details">
                      #{String(r.cells?.c_index ?? '?')} {String(r.cells?.c_company || r.cells?.c_title || 'Untitled')}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </aside>

      {detailRow && (
        <EventDetail row={detailRow} columns={columns} hideFields={hideFields} canEdit={canEdit} userTz={userTz}
          onPatch={onPatch} onDelete={onDelete} onClose={() => { onRelease(); setDetailId(''); }}
          lockOf={lockOf} onClaim={onClaim} onRelease={onRelease}
          onOpenRow={(rid) => { onRelease(); setDetailId(''); onOpenRow(rid); }} />
      )}
    </div>
  );
}

/** Double-click a call → edit it here, or delete it.
 *
 * Writes go through the SAME per-cell path the table uses (onPatch → commitCell), so every edit made
 * here broadcasts live, notifies the right people, respects the per-cell locks, and undoes with Ctrl+Z.
 * Fields the caller is not allowed to touch are disabled rather than hidden — seeing that the Company
 * is "Acme" and simply not being able to change it is more useful than the field vanishing.
 */
function EventDetail({ row, columns, hideFields, canEdit, userTz, onPatch, onDelete, onOpenRow, onClose,
                      lockOf, onClaim, onRelease }: {
  row: CalRow; columns: CalCol[]; hideFields?: Set<string>; canEdit: (rowId: string, colId: string) => boolean;
  userTz: string; onPatch: (rowId: string, colId: string, v: any) => void;
  onDelete?: (rowId: string) => void; onOpenRow: (rowId: string) => void; onClose: () => void;
  lockOf: (rowId: string, colId: string) => string | null;
  onClaim: (rowId: string, colId: string) => void;
  onRelease: () => void;
}) {
  const colById = useMemo(() => Object.fromEntries(columns.map((c) => [c.id, c])), [columns]);
  // Text fields commit on blur, not per keystroke — otherwise every character is a PATCH, a broadcast
  // and a notification. Selects and the date commit immediately, because there is nothing to finish typing.
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => { setDraft({}); }, [row.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const valueOf = (cid: string) => draft[cid] ?? String(row.cells?.[cid] ?? '');
  const commit = (cid: string, v: string) => {
    if (v === String(row.cells?.[cid] ?? '')) return;      // nothing actually changed
    onPatch(row.id, cid, v);
  };

  const schedTs = (() => { const t = new Date(String(row.cells?.c_sched ?? '')).getTime(); return isNaN(t) ? NaN : t; })();
  const title = String(row.cells?.c_company || row.cells?.c_title || 'Interview').trim();

  const field = (cid: string) => {
    if (hideFields?.has(cid)) return null;          // not for this role — see hideFields
    const raw = colById[cid];
    if (!raw) return null;
    const col = effCol(raw, row.cells);             // Approved can't be Confirmed with nobody assigned
    // Somebody else is in this exact field right now. The server would refuse our write (409) — so make
    // it read-only and name them, rather than letting us type into something that will be thrown away.
    const heldBy = lockOf(row.id, cid);
    const editable = canEdit(row.id, cid) && !heldBy;
    // The Caller cell is where a TEAM assignment lives too: handing a call to a team writes c_team and
    // leaves c_caller empty. Without this fallback the dropdown reads blank the instant after you pick a
    // team — which is exactly what made assigning to a team look like it had failed.
    const val = (cid === 'c_caller' && !valueOf('c_caller'))
      ? String(row.cells?.c_team ?? '').trim()
      : valueOf(cid);

    let input: React.ReactNode;
    if (cid === 'c_sched') {
      // datetime-local speaks NAIVE local time; the server re-anchors it using this user's timezone —
      // the same contract the table's Scheduled_at cell uses. Do not send a UTC string here.
      input = (
        <input type="datetime-local" disabled={!editable}
          value={isNaN(schedTs) ? '' : wallClockIn(schedTs, userTz)}
          onChange={(e) => e.target.value && onPatch(row.id, cid, e.target.value)} />
      );
    } else if ((col.type === 'select' || col.type === 'person') && (col.options || []).length) {
      const opts = col.options || [];
      const loose = opts.filter((o) => !o.kind);                       // ungrouped people / plain options
      const teams = opts.filter((o) => o.kind === 'team');
      input = (
        <select disabled={!editable} value={val} onChange={(e) => onPatch(row.id, cid, e.target.value)}>
          <option value="">—</option>
          {loose.map((o) => <option key={o.label} value={o.label}>{o.label}</option>)}
          {teams.map((t) => (
            <optgroup key={t.label} label={t.label}>
              <option value={t.label}>{t.label} · whole team</option>
              {opts.filter((o) => o.kind === 'member' && o.group === t.label)
                   .map((o) => <option key={o.label} value={o.label}>{o.label}</option>)}
            </optgroup>
          ))}
        </select>
      );
    } else {
      input = (
        <input type={col.type === 'url' ? 'url' : 'text'} disabled={!editable} value={val}
          onFocus={() => onClaim(row.id, cid)}
          // A call booked by dragging arrives with a time and nothing else. Land the cursor in Company
          // Info so you can just start typing, rather than hunting for the first field.
          autoFocus={cid === 'c_company' && editable && !String(row.cells?.c_company ?? '').trim()}
          onChange={(e) => setDraft((d) => ({ ...d, [cid]: e.target.value }))}
          onBlur={(e) => { commit(cid, e.target.value); onRelease(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      );
    }
    return (
      <label key={cid} className={'cal-fld' + (editable ? '' : ' cal-fld--ro')}>
        <span className="cal-fld-l">
          {col.name}{cid === 'c_sched' ? ` (${tzShort(userTz) || userTz})` : ''}
          {heldBy && <span className="cal-fld-held" title={`${heldBy} is editing this right now`}>✎ {heldBy}</span>}
        </span>
        {input}
      </label>
    );
  };

  return createPortal(
    <div className="cal-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cal-modal" role="dialog" aria-label="Interview detail">
        <header className="cal-modal-h">
          <h3>{title}</h3>
          <button className="ghost cal-modal-x" onClick={onClose} title="Close (Esc)">✕</button>
        </header>

        <div className="cal-modal-b">
          {DETAIL_FIELDS.map(field)}
        </div>

        <footer className="cal-modal-f">
          {onDelete && (
            <button className="cal-del"
              onClick={() => {
                if (!confirm(`Delete “${title}”? This removes the interview and its chat for everyone.`)) return;
                onDelete(row.id);
                onClose();
              }}>
              Delete
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="secondary" onClick={() => onOpenRow(row.id)}>
            Open in table
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** The selected caller's week, in their words and in yours. */
function Availability_({ p, viewerTz, weekFrom, bands }: {
  p: CalPerson; viewerTz: string; weekFrom: string; bands: Record<string, Band[]>;
}) {
  const ctz = p.timezone || '';
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekFrom, i));
  const DOW: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

  return (
    <div className="cal-av">
      <div className="cal-av-tz">
        {ctz
          ? <>Working hours are <b>{tzShort(ctz) || ctz}</b> ({ctz.split('/').pop()?.replace('_', ' ')}); shown below in <b>{tzShort(viewerTz) || viewerTz}</b>, your time.</>
          : <span className="cal-av-warn">⚠ This caller has no timezone set, so their hours are assumed to be yours. Set it on their account to place them correctly.</span>}
      </div>

      <ul className="cal-av-list">
        {days.map((d) => {
          const bs = bands[d] || [];
          const dk = dayKeyOf(d);
          const own = p.availability?.[dk];
          const isOff = (p.days_off || []).includes(d);
          return (
            <li key={d} className={'cal-av-row' + (bs.length ? '' : ' cal-av-row--off')}>
              <span className="cal-av-d">{DOW[dk]}</span>
              <span className="cal-av-h">
                {bs.length
                  ? bs.map((b) => `${hhmm(b.startMin)}–${hhmm(b.endMin === 24 * 60 ? 24 * 60 - 1 : b.endMin)}`).join(', ')
                  : isOff ? 'Day off' : !own?.on ? 'Not working' : '—'}
              </span>
              {ctz && own?.on && !isOff && (
                <span className="cal-av-own" title={`Their local hours (${tzShort(ctz) || ctz})`}>{own.start}–{own.end}</span>
              )}
            </li>
          );
        })}
      </ul>

      {(p.days_off || []).length > 0 && (
        <p className="cal-av-off">
          <b>Days off:</b> {(p.days_off || []).slice(0, 6).join(', ')}
          {(p.days_off || []).length > 6 ? ` +${(p.days_off || []).length - 6} more` : ''}
        </p>
      )}
    </div>
  );
}
