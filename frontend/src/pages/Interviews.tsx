import { type CSSProperties, type MouseEvent as ReactMouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { disablePush, enablePush, initPushSound, notifPermission, pushSupported, sendTestPush, syncPushIfGranted } from '../lib/push';
import { useAuth } from '../lib/auth';

/* `kind`/`group` only matter for the Caller dropdown, which is a two-level tree:
     caller 1                 ← ungrouped caller (kind undefined)
     caller 2
     Hamna Team  ▸            ← kind:'team'  — picking this assigns the whole TEAM
        caller 3              ← kind:'member', group:'Hamna Team'
        caller 4
   Everywhere else options are a plain flat list and these stay undefined. */
type Opt = { label: string; color: string; kind?: 'team' | 'member'; group?: string };
type Col = { id: string; name: string; type: string; options: Opt[]; width?: number };
type Row = { id: string; cells: Record<string, any> };
type Grid = { columns: Col[]; rows: Row[] };

/** Canonical column order: Index, Scheduled_at, Call Type, Company Info, Caller, Profile Name,
    Position/Title, Job Description, Creater(last). Hidden/merged-secondary columns keep their
    relative order after the visible ones. Applied to the grid state on load so render + keyboard +
    clipboard all agree on the order. */
const COL_RANK_ADMIN: Record<string, number> = {
  c_index: 0, c_sched: 1, c_type: 2, c_company: 3, c_caller: 4, c_account: 5, c_title: 6, c_jd: 7, c_creater: 8,
};
// Caller view: the Caller & Creater columns are dropped; Approved + Status are combined into
// one stacked column (Approved over Status), placed last — after Job Description.
const COL_RANK_CALLER: Record<string, number> = {
  c_index: 0, c_sched: 1, c_type: 2, c_company: 3, c_account: 4, c_title: 5, c_jd: 6, c_approved: 7,
};
function orderColumns(g: Grid): Grid {
  const rank = (id: string) => (id in L.COL_RANK ? L.COL_RANK[id] : 100);   // unranked (hidden/custom) → after, stable
  return { ...g, columns: [...(g.columns || [])].sort((a, b) => rank(a.id) - rank(b.id)) };
}

const TYPES: { value: string; label: string }[] = [
  { value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select' }, { value: 'person', label: 'Person' }, { value: 'checkbox', label: 'Checkbox' },
  { value: 'url', label: 'Link' }, { value: 'file', label: 'File' }, { value: 'button', label: 'Button' },
  { value: 'email', label: 'Email' }, { value: 'phone', label: 'Phone' },
];
/* Notion's documented dark-mode tag tokens — each select option resolves to one
   of these {bg, text} pairs, so pills get Notion's muted look (not neon). */
const NOTION: Record<string, { bg: string; text: string }> = {
  gray:   { bg: '#252525', text: '#9B9B9B' },
  brown:  { bg: '#2E2724', text: '#A27763' },
  orange: { bg: '#36291F', text: '#CB7B37' },
  yellow: { bg: '#372E20', text: '#C19138' },
  green:  { bg: '#242B26', text: '#4F9768' },
  blue:   { bg: '#1F282D', text: '#447ACB' },
  purple: { bg: '#2A2430', text: '#865DBB' },
  pink:   { bg: '#2E2328', text: '#BA4A78' },
  red:    { bg: '#332523', text: '#BE524B' },
};
const NOTION_LIST = Object.values(NOTION);
const PALETTE = NOTION_LIST.map((c) => c.text); // option.color stores the token's text hex
const DEFAULT_W = 160;        // fallback column width (px)
const MIN_W = 60, MAX_W = 1000;
const SEL = '#2383E2';        // Coda/Sheets selection blue
// Fixed text columns: no ⋯ settings menu (can't be renamed/retyped/deleted). Still resizable + editable cells.
// Merged primaries are locked so an admin can't rename/delete them out of sync with the MERGED map below
// (admins can still edit their select-option lists via the ⋯ menu).
const LOCKED_COLS = new Set(['c_index', 'c_title', 'c_skill', 'c_client', 'c_type', 'c_sched', 'c_caller', 'c_creater', 'c_account', 'c_jd', 'c_company']);
// Stacked columns: render { primary: secondary } as ONE column with two stacked cells
// (primary on top, secondary below). The secondary column is hidden as a standalone column
// but stays in the schema so its cells still save. Each sub-cell keeps its own type.
// Here: Position/Title over Skillset, Call Type over Interviewer(role), Scheduled_at over Created_at.
// Each key is a VISIBLE (primary) column; its value lists the sub-fields shown inside that one cell.
// A field's `row` is the visual row (0=top, 1=bottom); two fields on row 0 split the top cell
// horizontally (left|right). Field 0 is the primary column; the rest are hidden as standalone columns.
type SubField = { colId: string; row: 0 | 1; width?: number; icon?: string; hdText?: string; label?: string };   // width px for a split cell; icon/text/label override shown in the header
const MERGED_ADMIN: Record<string, SubField[]> = {
  c_title:   [{ colId: 'c_title', row: 0 }, { colId: 'c_skill', row: 1 }],
  c_company: [{ colId: 'c_company', row: 0 }, { colId: 'c_salary', row: 1 }],                     // Company Info / Salary Range
  c_type:    [{ colId: 'c_type', row: 0 }, { colId: 'c_client', row: 1 }],                        // Call Type / Interviewer(role)
  c_sched:   [{ colId: 'c_sched', row: 0 }, { colId: 'c_min', row: 0, width: 35, icon: '🕐', hdText: '(min)' }, { colId: 'c_link', row: 1, label: 'Meeting Link' }],  // Scheduled_at | 🕐 (min) / Meeting Link
  c_caller:  [{ colId: 'c_caller', row: 0 }, { colId: 'c_approved', row: 1 }],
  c_creater: [{ colId: 'c_creater', row: 0 }, { colId: 'c_status', row: 1 }],                    // Creater / Status
  c_account: [{ colId: 'c_account', row: 0 }, { colId: 'c_resume', row: 1, label: 'Resume' }],     // Profile Name(Country) / Resume
  c_jd:      [{ colId: 'c_jd', row: 0 }, { colId: 'c_feedback', row: 1, label: 'Chat & Feedback' }], // Job Description / Chat & Feedback
};
// Caller view: the Caller and Creater columns are admin-only and dropped entirely. Approved &
// Status are combined into one stacked column (Approved over Status), styled like the other
// two-line cells (Company Info / Salary, Profile Name / Resume, …). Every other stack is
// identical to the admin view (Scheduled_at keeps min + Meeting Link, etc.).
const MERGED_CALLER: Record<string, SubField[]> = {
  c_title:    MERGED_ADMIN.c_title,
  c_company:  MERGED_ADMIN.c_company,
  c_type:     MERGED_ADMIN.c_type,
  c_sched:    MERGED_ADMIN.c_sched,
  c_account:  MERGED_ADMIN.c_account,
  c_jd:       MERGED_ADMIN.c_jd,
  c_approved: [{ colId: 'c_approved', row: 0 }, { colId: 'c_status', row: 1 }],   // Approved / Status
};
// Displayed names that differ from the persisted column name (display-only override; used for headers AND cells).
const DISPLAY_NAME: Record<string, string> = { c_account: 'Profile Name(Country)', c_jd: 'Job Description', c_feedback: 'Chat & Feedback' };
// Select columns offered as dropdown filters above the table (c_caller is admin-only).
const FILTER_COLS = ['c_type', 'c_approved', 'c_status', 'c_account', 'c_caller'];
// Filters only admins/managers get. The API hands every user the full column list (the frontend is
// what hides them), so without this a caller would be offered a Caller filter they can't see.
const STAFF_ONLY_FILTERS = new Set(['c_caller']);
// Created_at is data-only now: hidden from the grid, surfaced on Index hover (see the row render).
function buildStackHidden(merged: Record<string, SubField[]>, extra: string[] = []): Set<string> {
  return new Set<string>([...Object.values(merged).flatMap((fs) => fs.slice(1).map((f) => f.colId)), 'c_created', ...extra]);
}
// c_team is data-only: it records which team a call was handed to (written when you pick a team in
// the Caller dropdown, and used to scope a manager's board), but it is never shown as its own
// column — the Caller cell displays the team until a person is assigned.
const STACK_HIDDEN_ADMIN = buildStackHidden(MERGED_ADMIN, ['c_team']);
// Callers also hide the admin-only Caller & Creater columns outright (Status is hidden as a
// standalone column too — it lives inside the combined Approved/Status cell).
const STACK_HIDDEN_CALLER = buildStackHidden(MERGED_CALLER, ['c_caller', 'c_creater', 'c_team']);

// The board schema is shared; only these three maps differ by role. `L` is the active layout
// for the session, set once at the top of <Interviews> (the app resolves the user before this
// route mounts, so the role is known on the first render). The pure helpers above and the
// once-bound document listeners below all read `L`, so render + keyboard + clipboard agree.
type Layout = { MERGED: Record<string, SubField[]>; STACK_HIDDEN: Set<string>; COL_RANK: Record<string, number> };
const ADMIN_LAYOUT: Layout = { MERGED: MERGED_ADMIN, STACK_HIDDEN: STACK_HIDDEN_ADMIN, COL_RANK: COL_RANK_ADMIN };
const CALLER_LAYOUT: Layout = { MERGED: MERGED_CALLER, STACK_HIDDEN: STACK_HIDDEN_CALLER, COL_RANK: COL_RANK_CALLER };
// Team-manager view: the caller's board PLUS the Caller column, so a manager can hand a call to
// another caller on their team. Same stacks as a caller (Approved/Status combined); only Creater is
// hidden. Caller sits right after Company Info, exactly where an admin sees it.
const STACK_HIDDEN_MANAGER = buildStackHidden(MERGED_CALLER, ['c_creater', 'c_team']);
const COL_RANK_MANAGER: Record<string, number> = {
  c_index: 0, c_sched: 1, c_type: 2, c_company: 3, c_caller: 4, c_account: 5, c_title: 6, c_jd: 7, c_approved: 8,
};
const MANAGER_LAYOUT: Layout = { MERGED: MERGED_CALLER, STACK_HIDDEN: STACK_HIDDEN_MANAGER, COL_RANK: COL_RANK_MANAGER };
let L: Layout = ADMIN_LAYOUT;
const isMerged = (colId: string): boolean => colId in L.MERGED;
// Creater fills on CLICK (current user) once the row's Index is set; Created_at is auto-stamped (see commitCell).
const AUTO_NOW_COLS = new Set<string>();                 // (none: Created_at is auto-stamped, not click-filled)
const AUTO_ME_COLS = new Set<string>(['c_creater']);    // click an empty cell → stamp current user
const rowIndexSet = (row: Row): boolean => { const v = row.cells?.c_index; return v != null && v !== ''; };
// A caller is read-only on the board except these columns — Approved, Status, and the
// Chat & Feedback thread (c_feedback); admins may edit everything. Backend enforces this too.
const CALLER_EDITABLE = new Set<string>(['c_approved', 'c_status', 'c_feedback']);
// A team manager may additionally hand a call to another caller — but only one on their own team
// (the backend rejects anyone else, and their Caller dropdown only lists the team).
const MANAGER_EDITABLE = new Set<string>([...CALLER_EDITABLE, 'c_caller']);
function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type SelRect = { r1: number; c1: number; r2: number; c2: number };
type SubState = 'none' | 'fill' | 'anchor';
type Dir = 'up' | 'down' | 'left' | 'right';
/** Flat "logical" columns for the whole grid: each merged sub-field becomes one addressable column,
    in visual order. This is what clipboard/fill operate on so the merged layout stays a render concern. */
function fieldIdsOf(col: Col): string[] { const m = L.MERGED[col.id]; return m ? m.map((f) => f.colId) : [col.id]; }
function logicalCols(vis: Col[]): { c: number; sub: number; colId: string }[] {
  const out: { c: number; sub: number; colId: string }[] = [];
  vis.forEach((col, c) => fieldIdsOf(col).forEach((colId, sub) => out.push({ c, sub, colId })));
  return out;
}
/** Which subs of a stacked cell at (r,c) are inside the selection — sub-precise so a drag that
    starts on the bottom sub doesn't grab the top sub above it. */
function subsOf(sel: SelRect, aSub: number, r: number, c: number, rows: number[]): number[] {
  const rmin = Math.min(sel.r1, sel.r2), rmax = Math.max(sel.r1, sel.r2);
  const cmin = Math.min(sel.c1, sel.c2), cmax = Math.max(sel.c1, sel.c2);
  if (r < rmin || r > rmax || c < cmin || c > cmax) return [];
  const all = rows.map((_, i) => i);
  if (sel.r1 === sel.r2 && sel.c1 === sel.c2) return [aSub];        // single cell → just the clicked sub-field
  if (rmin === rmax) return all;                                    // single-row (horizontal) range → whole cell
  const isAnchor = sel.r1 === r && sel.c1 === c;
  // anchor cell: keep the anchor field itself + fields on STRICTLY lower/higher visual rows — never a
  // same-row split sibling (so dragging down from `duration` doesn't grab `Call Type` beside it).
  if (isAnchor && r === rmin) { const from = rows[aSub] ?? 0; return all.filter((i) => i === aSub || rows[i] > from); }  // dragging down
  if (isAnchor && r === rmax) { const to = rows[aSub] ?? 0; return all.filter((i) => i === aSub || rows[i] < to); }      // dragging up
  return all;
}

/** Per-column-type clipboard codec: turn any cell value into a plain string (copy) and back (paste),
    so NON-text cells (select/date/checkbox/person/…) round-trip as TSV with Excel/Sheets/Notion. */
function serializeCell(col: Col | undefined, value: any): string {
  if (!col || value === null || value === undefined) return '';
  if (col.type === 'checkbox') return value ? 'TRUE' : 'FALSE';
  if (col.type === 'button') return '';
  return String(value);   // text/number/email/phone/url/file/date/select/person all store a string
}
function parseCell(col: Col | undefined, str: string, prev: any): any {
  if (!col) return prev;
  const s = (str ?? '').trim();
  switch (col.type) {
    case 'button': return prev;                                   // buttons hold no value
    case 'checkbox': return /^(true|1|yes|y|x|✓|checked|done)$/i.test(s);
    case 'number': return s === '' ? '' : (Number.isNaN(Number(s)) ? prev : Number(s));
    case 'select': {                                              // only accept a real option label
      if (s === '') return '';
      const m = col.options.find((o) => o.label.toLowerCase() === s.toLowerCase());
      return m ? m.label : prev;
    }
    default: return s;                                            // text/email/phone/url/file/date/person
  }
}

function hexToRgb(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((h || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Snap any stored hex to the nearest Notion token (handles legacy bright colors). */
function resolveNotion(hex: string): { bg: string; text: string } {
  const rgb = hexToRgb(hex);
  if (!rgb) return NOTION.gray;
  let best = NOTION.gray, bd = Infinity;
  for (const c of NOTION_LIST) {
    const t = hexToRgb(c.text)!;
    const d = (t[0] - rgb[0]) ** 2 + (t[1] - rgb[1]) ** 2 + (t[2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function useOutside(active: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

/** "2026-03-13T00:00" → "3/13, 00:00" ; "2026-03-13" → "3/13" (no TZ math). */
function fmtDate(s: string): string {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return s;
  return m[4] ? `${+m[2]}/${+m[3]}, ${m[4]}:${m[5]}` : `${+m[2]}/${+m[3]}`;
}
function initials(name: string): string {
  const n = name.trim();
  return n ? n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '';
}

// ── Chat & Feedback thread (the c_feedback cell stores a JSON list of these) ──
type ChatMsg = { id: string; author?: string; avatar?: string; at?: string; text: string; image?: string };
/** Inline chat image — fetched with auth as a blob (screenshots are auth-gated). Click to preview it
    full-size in an in-page lightbox (onZoom), not a new tab. */
function ChatImage({ url, onZoom }: { url: string; onZoom: (src: string) => void }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let obj = ''; let alive = true;
    api.raw.get(url, { responseType: 'blob' }).then((r: any) => { if (alive) { obj = URL.createObjectURL(r.data); setSrc(obj); } }).catch(() => {});
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [url]);
  if (!src) return <div className="iv-chat-img iv-chat-img--load">🖼️</div>;
  return <img className="iv-chat-img" src={src} alt="attachment" onClick={(e) => { e.stopPropagation(); onZoom(src); }} />;
}
function parseChatMsgs(value: string): ChatMsg[] {
  const s = (value ?? '').trim();
  if (!s) return [];
  try { const a = JSON.parse(s); if (Array.isArray(a)) return a.filter((m) => m && typeof m.text === 'string'); } catch { /* legacy plain text */ }
  return [{ id: 'legacy', text: s }];
}
/** Format a timestamp in the given IANA time zone (from the user's profile). A UTC/offset instant
    (chat message, Created_at) is converted to that zone; a bare wall-clock value (a user-typed date)
    is shown as-is. Falls back to the browser zone when tz is empty/invalid. */
function tsInTz(value?: string, tz?: string): string {
  const s = (value || '').trim();
  if (!s) return '';
  if (/(?:z|[+-]\d\d:?\d\d)$/i.test(s)) {          // real instant (ends in Z or a ±hh:mm offset)
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const opts: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' };
      try { return d.toLocaleString([], { ...opts, timeZone: tz || undefined }); }
      catch { return d.toLocaleString([], opts); }
    }
  }
  return fmtDate(s);                                // wall-clock, shown as entered
}
/** Minutes offset such that: local_time_in_tz = utc_time + offset. Uses the browser zone when tz is empty. */
function tzOffsetMin(instant: Date, tz?: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p: any = {};
    for (const part of dtf.formatToParts(instant)) if (part.type !== 'literal') p[part.type] = Number(part.value);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    return Math.round((asUTC - instant.getTime()) / 60000);
  } catch { return -instant.getTimezoneOffset(); }
}
/** A wall-clock the user typed (in their tz) → the absolute UTC instant it represents (ISO). */
function wallToUtc(wall: string, tz?: string): string {
  const m = (wall || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return wall;
  const wallAsUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = tzOffsetMin(new Date(wallAsUtc), tz);
  let utc = wallAsUtc - off * 60000;
  const off2 = tzOffsetMin(new Date(utc), tz);      // refine across a DST boundary
  if (off2 !== off) utc = wallAsUtc - off2 * 60000;
  return new Date(utc).toISOString();
}
/** A UTC instant → the "YYYY-MM-DDTHH:MM" wall-clock in tz (for a datetime-local input). */
function utcToWall(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() + tzOffsetMin(d, tz) * 60000);   // shift so UTC components == local wall-clock
  const p = (n: number) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}`;
}
/** Split message text into plain segments and URL segments (so recording links are clickable). */
function linkify(text: string): (string | { url: string })[] {
  const out: (string | { url: string })[] = [];
  const re = /(https?:\/\/[^\s]+)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ url: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
/** Make a stored link a SAFE absolute URL. A schemeless value (e.g. "meet.google.com/x") gets https://
    so it opens the real site instead of resolving against the app origin (which produced .../interviews).
    Dangerous schemes (javascript:, data:, vbscript:, …) are rejected → '' so we never render them live. */
function toHref(raw: string): string {
  const u = (raw || '').trim();
  if (!u) return '';
  const hier = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(u);   // "scheme://…" (http, javascript, data, …)
  if (hier) return /^https?$/i.test(hier[1]) ? u : '';      // only http/https may keep an explicit scheme; block the rest
  if (/^(mailto|tel):/i.test(u)) return u;                  // safe schemeless-authority schemes
  return `https://${u}`;                                    // bare host/path (neutralises a bare "javascript:…" too)
}

/** Compact multi-select (checkable) filter dropdown for the filter bar. */
function FilterDropdown({ label, options, selected, onChange }: {
  label: string; options: string[]; selected: string[]; onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const set = new Set(selected);
  const toggle = (v: string) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); onChange(Array.from(n)); };
  const summary = selected.length === 0 ? label : selected.length === 1 ? selected[0] : `${label} · ${selected.length}`;
  return (
    <div ref={ref} className="iv-flt-dd">
      <button type="button" className={'iv-flt-ddbtn' + (selected.length ? ' on' : '')} onClick={() => setOpen((o) => !o)} title={label}>
        <span className="iv-flt-ddtx">{summary}</span><span className="iv-flt-ddcaret">▾</span>
      </button>
      {open && (
        <div className="card iv-flt-ddmenu">
          {options.length === 0 && <div className="muted" style={{ padding: 6, fontSize: '0.78rem' }}>No options</div>}
          {options.map((o) => (
            <label key={o} className="iv-flt-ddopt">
              <input type="checkbox" checked={set.has(o)} onChange={() => toggle(o)} /><span>{o}</span>
            </label>
          ))}
          {selected.length > 0 && <button className="ghost iv-flt-ddclear" onClick={() => onChange([])}>Clear</button>}
        </div>
      )}
    </div>
  );
}

function Pill({ opt }: { opt: Opt }) {
  const c = resolveNotion(opt.color);
  return <span className="iv-pill" style={{ background: c.bg, color: c.text }}>{opt.label}</span>;
}

/* ---- cells: display-by-default, EDIT controlled by the grid (double-click) ----
   Inputs stopPropagation on mousedown so cursor placement / text selection inside an
   open editor doesn't start a grid cell-selection drag. */
const stop = (e: ReactMouseEvent) => e.stopPropagation();

/** Cell text editor that commits on blur AND on unmount — so clicking away saves (Sheets/Notion
    style), exactly once. Enter commits + closes; Escape cancels. */
function EditInput({ type = 'text', initial, seeded, placeholder, onCommit, onDone }: {
  type?: string; initial: string; seeded?: boolean; placeholder?: string; onCommit: (v: string) => void; onDone: (dir?: Dir) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const dirty = useRef(false);   // true once the user actually edits (typing, or the date/time picker changing the value)
  // commit once; skip a write that didn't change anything (but a seeded/typed edit always commits)
  const commit = (v: string) => { if (done.current) return; done.current = true; if (seeded || v !== initial) onCommit(v); };
  useEffect(() => {
    const el = ref.current;
    // Save a pending edit on real click-away (unmount without a blur). Gated on `dirty` so React
    // StrictMode's dev-only mount→unmount→mount can't fire a premature commit that flips `done` and
    // blocks the real edit from ever saving (which made date/text cells look uneditable in dev).
    return () => { if (el && dirty.current) commit(el.value); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input ref={ref} className="iv-input" type={type} autoFocus defaultValue={initial} placeholder={placeholder} onMouseDown={stop}
      onChange={() => { dirty.current = true; }}
      onBlur={(e) => { const wasDone = done.current; commit(e.target.value); if (!wasDone) onDone(); }}
      onKeyDown={(e) => {
        // Enter/Tab commit AND move the active cell (Sheets/Notion); Escape cancels in place.
        if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); onDone(e.shiftKey ? 'up' : 'down'); }
        else if (e.key === 'Tab') { e.preventDefault(); commit(e.currentTarget.value); onDone(e.shiftKey ? 'left' : 'right'); }
        else if (e.key === 'Escape') { e.preventDefault(); done.current = true; onDone(); }
      }} />
  );
}

type CellProps = { col: Col; value: any; editing: boolean; onCommit: (v: any) => void; onDone: (dir?: Dir) => void; onOpen?: () => void; seed?: string; avatar?: string; tz?: string };

function TextCell({ col, value, editing, seed, onCommit, onDone }: CellProps) {
  if (editing) {
    const t = col.type === 'number' ? 'number' : col.type === 'email' ? 'email' : col.type === 'phone' ? 'tel' : 'text';
    const commit = (r: string) => onCommit(col.type === 'number' ? (r === '' ? null : Number(r)) : r);
    return <EditInput type={t} initial={seed != null ? seed : (value === null || value === undefined ? '' : String(value))} seeded={seed != null} onCommit={commit} onDone={onDone} />;
  }
  const txt = value === '' || value === null || value === undefined ? '' : String(value);
  return <div className="iv-disp" title={txt}>{txt}</div>;
}

function DateCell({ value, editing, tz, onCommit, onDone }: Omit<CellProps, 'col'>) {
  const v = (value ?? '').toString();
  const isInstant = /(?:z|[+-]\d\d:?\d\d)$/i.test(v);   // stored as UTC instant vs. legacy wall-clock
  if (editing) {
    // the datetime-local input edits a wall-clock in the user's tz; commit converts it back to a UTC instant
    const wall = isInstant ? utcToWall(v, tz) : (v.length === 10 ? `${v}T00:00` : v);
    return <EditInput type="datetime-local" initial={wall} onCommit={(w) => onCommit(w ? wallToUtc(w, tz) : '')} onDone={onDone} />;
  }
  const shown = v ? tsInTz(v, tz) : '';                 // display in the viewer's tz
  return <div className="iv-disp" title={shown}>{shown}</div>;
}

const OPT_MENU_H = 300;   // the option list's preferred height

type MenuPos = { up: boolean; top: number; bottom: number; left: number; width: number; maxH: number };

function SelectCell({ col, value, editing, seed, onCommit, onDone, onOpen }: CellProps) {
  const cellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);                                          // keyboard-highlighted option
  const [pos, setPos] = useState<MenuPos | null>(null);
  useEffect(() => { setQ(editing ? (seed ?? '') : ''); }, [editing, seed]);   // seed the search with a typed char
  useEffect(() => { setHl(0); }, [q, editing]);

  // Close on a click outside BOTH the cell and the (portalled) list. The list lives in <body>, so a
  // plain "outside the cell" test would count clicking an option as outside and close it first.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (cellRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      onDone();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [editing, onDone]);

  // Place the list against the VIEWPORT, not the table. It's portalled out of .iv-wrap (which is
  // `overflow:auto`), so the table can no longer clip it — previously it was cut off below the last
  // rows and past the right edge on the right-most column (the caller's Approved/Status). Flips above
  // the cell when it can't fit below, and is nudged left so it always stays on screen.
  useLayoutEffect(() => {
    if (!editing) { setPos(null); return; }
    const place = () => {
      const el = cellRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const width = Math.max(200, r.width);
      const below = vh - r.bottom - 8;
      const above = r.top - 8;
      const up = below < OPT_MENU_H && above > below;
      setPos({
        up,
        top: r.bottom + 4,
        bottom: vh - r.top + 4,
        left: Math.max(8, Math.min(r.left, vw - width - 8)),          // keep it fully on screen
        width,
        maxH: Math.max(140, Math.min(OPT_MENU_H, up ? above : below)),
      });
    };
    place();
    window.addEventListener('scroll', place, true);   // capture → also follows the grid's own scroll
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [editing]);

  const cur = col.options.find((o) => o.label === value);
  const ql = q.trim().toLowerCase();
  const filtered = ql ? col.options.filter((o) => o.label.toLowerCase().includes(ql)) : col.options;
  const pick = (label: string) => { onCommit(label); onDone(); };
  return (
    <div ref={cellRef} className="iv-cell" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', minHeight: 32 }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>{cur
        ? <Pill opt={cur} />
        : (value ? <span className="muted" style={{ fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '100%' }} title={String(value)}>{String(value)}</span> : null)}</span>
      {/* the dropdown opens only from this arrow (or a double-click on the cell) */}
      <span className="iv-caret" title="Open" onMouseDown={(e) => { e.stopPropagation(); if (editing) onDone(); else onOpen?.(); }}>▾</span>
      {editing && pos && createPortal(
        <div ref={menuRef} className="card" onMouseDown={stop} style={{
          position: 'fixed', left: pos.left, width: pos.width, zIndex: 200, padding: 6,
          maxHeight: pos.maxH, overflowY: 'auto',
          ...(pos.up ? { bottom: pos.bottom } : { top: pos.top }),
        }}>
          <input className="iv-search" autoFocus value={q} placeholder="Search…" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(filtered.length - 1, h + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); if (filtered[hl]) pick(filtered[hl].label); }
              else if (e.key === 'Escape') { e.preventDefault(); onDone(); }
            }} />
          <div className="iv-opt muted" onClick={() => { onCommit(''); onDone(); }} style={{ padding: '5px 6px', cursor: 'pointer', fontSize: '0.78rem', borderRadius: 6 }}>✕ Clear</div>
          {filtered.length === 0 && <div className="muted" style={{ padding: 6, fontSize: '0.76rem' }}>No matches</div>}
          {filtered.map((o, i) => (
            <div key={(o.group || '') + o.label} className={'iv-opt' + (i === hl ? ' iv-opt-hl' : '')}
              onMouseEnter={() => setHl(i)} onClick={() => pick(o.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, borderRadius: 6, cursor: 'pointer',
                // team members sit indented under their team header (the tree in the Caller dropdown)
                padding: o.kind === 'member' ? '5px 6px 5px 22px' : '5px 6px',
                marginTop: o.kind === 'team' ? 4 : 0,
              }}>
              {o.kind === 'team' && <span style={{ opacity: 0.55, fontSize: '0.72rem' }}>▾</span>}
              {o.kind === 'member' && <span style={{ opacity: 0.3, fontSize: '0.72rem' }}>└</span>}
              <Pill opt={o} />
              {o.kind === 'team' && (
                <span className="muted" style={{ fontSize: '0.7rem', marginLeft: 'auto' }}>whole team</span>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function PersonCell({ value, editing, seed, avatar, onCommit, onDone }: Omit<CellProps, 'col'>) {
  const name = (value ?? '').toString();
  if (editing) return <EditInput initial={seed != null ? seed : name} seeded={seed != null} onCommit={onCommit} onDone={onDone} />;
  return (
    <div className="iv-cell" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 8px', minHeight: 32 }}>
      {name ? <>
        {avatar
          ? <img className="iv-av" src={avatar} alt="" style={{ objectFit: 'cover' }} />
          : <span className="iv-av" style={{ background: 'rgba(68,122,203,0.20)', color: '#447ACB' }}>{initials(name)}</span>}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      </> : <span style={{ flex: 1 }} />}
      <span className="iv-caret">▾</span>
    </div>
  );
}

function LinkCell({ value, editing, seed, onCommit, onDone }: Omit<CellProps, 'col'>) {
  const toast = useToast();
  const url = (value ?? '').toString();
  if (editing) return <EditInput type="url" initial={seed != null ? seed : url} seeded={seed != null} placeholder="https://…" onCommit={onCommit} onDone={onDone} />;
  if (!url) return <div className="iv-cell" style={{ minHeight: 32 }} />;   // no link → blank cell (copy button hidden)
  const href = toHref(url);
  const copy = (e: ReactMouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(url).then(() => toast('Meeting link copied', 'success')).catch(() => toast('Copy failed', 'error'));
  };
  return (
    <div className="iv-cell" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', minHeight: 32 }}>
      {href
        ? <a href={href} target="_blank" rel="noreferrer noopener" title={url} onClick={(e) => e.stopPropagation()} onMouseDown={stop} style={{ fontSize: '0.95rem', textDecoration: 'none', lineHeight: 1 }}>🌐</a>
        : <span title={`Unsafe link: ${url}`} style={{ opacity: 0.35, fontSize: '0.95rem', lineHeight: 1 }}>🌐</span>}
      <span title={url} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.78rem', color: href ? '#60a5fa' : '#9B9B9B' }}>{url}</span>
      <button className="iv-copybtn" title="Copy meeting link" onMouseDown={stop} onClick={copy}>⧉</button>
    </div>
  );
}

function FileCell({ value, editing, seed, onCommit, onDone }: Omit<CellProps, 'col'>) {
  const name = (value ?? '').toString();
  if (editing) return <EditInput initial={seed != null ? seed : name} seeded={seed != null} placeholder="filename or URL" onCommit={onCommit} onDone={onDone} />;
  return (
    <div className="iv-cell" style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', minHeight: 32 }}>
      {name ? <span style={{ opacity: 0.55 }}>📎</span> : null}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.8rem' }}>{name}</span>
    </div>
  );
}

/** Resume cell — styled like the Meeting Link cell (icon + label + copy). Clicking opens/downloads the
    resume: an internal /api/… path is fetched with auth as a blob (the browser can't send the token on a
    plain <a>), an external URL opens directly. */
function ResumeCell({ value, editing, seed, onCommit, onDone }: Omit<CellProps, 'col'>) {
  const toast = useToast();
  const raw = (value ?? '').toString().trim();
  if (editing) return <EditInput initial={seed != null ? seed : raw} seeded={seed != null} placeholder="resume URL" onCommit={onCommit} onDone={onDone} />;
  if (!raw) return <div className="iv-cell" style={{ minHeight: 32 }} />;
  const isExternal = /^https?:\/\//i.test(raw);
  const isApi = raw.startsWith('/api/') || raw.includes('/api/resumes/');
  const downloadable = isExternal || isApi;
  const label = isApi ? 'Resume' : raw;                               // internal path → friendly label
  const open = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    try {
      if (isExternal) { window.open(toHref(raw), '_blank', 'noopener'); return; }
      const res = await api.raw.get(raw, { responseType: 'blob' });   // internal → authenticated blob
      const blob = res.data as Blob;
      if (!blob || blob.size === 0) throw new Error('empty');
      window.open(URL.createObjectURL(blob), '_blank');
    } catch { toast('Failed to open resume', 'error'); }
  };
  const copy = (e: ReactMouseEvent) => { e.stopPropagation(); navigator.clipboard?.writeText(raw).then(() => toast('Resume link copied', 'success')).catch(() => toast('Copy failed', 'error')); };
  return (
    <div className="iv-cell" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', minHeight: 32 }}>
      <span onClick={downloadable ? open : undefined} onMouseDown={stop} title={downloadable ? 'Open / download resume' : raw}
        style={{ fontSize: '0.95rem', lineHeight: 1, cursor: downloadable ? 'pointer' : 'default', opacity: downloadable ? 1 : 0.55 }}>📄</span>
      <span onClick={downloadable ? open : undefined} onMouseDown={stop} title={raw}
        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.78rem', color: downloadable ? '#60a5fa' : '#9B9B9B', cursor: downloadable ? 'pointer' : 'default' }}>{label}</span>
      <button className="iv-copybtn" title="Copy resume link" onMouseDown={stop} onClick={copy}>⧉</button>
    </div>
  );
}

function ButtonCell({ col, value, onOpen }: Pick<CellProps, 'col' | 'value' | 'onOpen'>) {
  const v = value == null ? '' : String(value).trim();
  const filled = v !== '' && v !== '[]';                                // has saved content (empty chat "[]" doesn't count)
  const icon = col.id === 'c_feedback' ? '💬' : '📄';                  // Note vs Job Details (name is display-overridden)
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3px 8px', minHeight: 32 }}>
      <button type="button" className={'iv-cellbtn' + (filled ? ' iv-cellbtn--on' : '')} title={(filled ? 'Open ' : 'Add ') + col.name}
        style={{ width: '100%', justifyContent: 'center' }}   /* full width → Job Details & Note match */
        onMouseDown={stop} onClick={(e) => { e.stopPropagation(); onOpen?.(); }}>
        <span className="iv-cellbtn-ic">{icon}</span><span className="iv-cellbtn-tx">{col.name}</span>
      </button>
    </div>
  );
}

/** Long-text cell modal. Editable (Note) → textarea that auto-saves on close. Read-only (Job Details) →
    a formatted, scrollable document view preserving the description's line breaks + spacing, with a Copy
    button that copies the exact text (so the format survives the copy). */
function CellModal({ title, subtitle, value, readOnly, onSave, onClose }: {
  title: string; subtitle?: string; value: string; readOnly?: boolean; onSave: (v: string) => void; onClose: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState(value);
  const textRef = useRef(text); textRef.current = text;
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!readOnly) { taRef.current?.focus(); taRef.current?.setSelectionRange(value.length, value.length); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { if (!readOnly && textRef.current !== value) onSave(textRef.current); onClose(); };
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); closeRef.current(); }
    };
    document.addEventListener('keydown', onKey, true);          // capture so the grid's Escape handler doesn't also run
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  const copy = () => {
    const t = textRef.current;
    navigator.clipboard?.writeText(t).then(() => toast('Copied', 'success')).catch(() => toast('Copy failed', 'error'));
  };
  return (
    <div className="iv-modal-backdrop" onMouseDown={close}>
      <div className="iv-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="iv-modal-hd">
          <div style={{ minWidth: 0 }}>
            <div className="iv-modal-title">{title}{readOnly ? <span className="muted" style={{ fontSize: '0.72rem', marginLeft: 8, fontWeight: 400 }}>view only</span> : null}</div>
            {subtitle ? <div className="iv-modal-sub" title={subtitle}>{subtitle}</div> : null}
          </div>
          <button className="ghost iv-modal-x" onClick={close} title="Close">✕</button>
        </div>
        {readOnly
          ? <div className="iv-modal-doc">{text || <span className="muted">(empty)</span>}</div>
          : <textarea ref={taRef} className="iv-modal-ta" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Write ${title}…`} />}
        <div className="iv-modal-ft">
          <button className="secondary" onClick={copy} title="Copy the full text">⧉ Copy</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="muted" style={{ fontSize: '0.72rem' }}>{readOnly ? 'Esc to close' : 'Auto-saves on close · Esc or ⌘/Ctrl+Enter'}</span>
            <button onClick={close}>{readOnly ? 'Close' : 'Done'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small confirmation dialog (e.g. deleting a row). Enter confirms, Esc / backdrop cancels. */
function ConfirmModal({ title, message, confirmLabel = 'Delete', danger, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onConfirm(); }
    };
    document.addEventListener('keydown', onKey, true);          // capture so the grid keys stay inert
    return () => document.removeEventListener('keydown', onKey, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="iv-modal-backdrop" onMouseDown={onCancel}>
      <div className="iv-modal iv-modal--sm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="iv-modal-hd"><div className="iv-modal-title">{title}</div></div>
        <div style={{ padding: '2px 18px 6px', fontSize: '0.86rem', color: '#CFCFCF', lineHeight: 1.55 }}>{message}</div>
        <div className="iv-modal-ft">
          <span />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ghost" onClick={onCancel}>Cancel</button>
            <button className={danger ? 'danger' : ''} onClick={onConfirm} autoFocus>{confirmLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Telegram-style thread for the Chat & Feedback column. Admins/callers post messages (chat history from
    LinkedIn/email, interview feedback, recording links); the full history is kept. Appends go through a
    dedicated server endpoint (atomic under the file lock) so concurrent posts never clobber each other. */
function ChatModal({ title, subtitle, value, me, readOnly, rowId, onSync, onClose }: {
  title: string; subtitle?: string; value: string; me: any; readOnly?: boolean; rowId: string;
  onSync: (jsonValue: string) => void; onClose: () => void;
}) {
  const toast = useToast();
  const tz = me?.timezone || undefined;                  // show times in the current user's time zone
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => parseChatMsgs(value));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [zoomSrc, setZoomSrc] = useState('');            // in-page image lightbox
  const zoomRef = useRef(''); zoomRef.current = zoomSrc;
  const meName = (me?.full_name || me?.username || '').trim();
  const isAdmin = !!me?.is_admin;

  useEffect(() => { if (!readOnly) taRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {   // fetch the freshest thread on open (another user may have posted since the board loaded)
    api.get<{ messages: ChatMsg[] }>(`/api/interviews/rows/${rowId}/chat`)
      .then((r) => { setMsgs(r.messages || []); onSync(JSON.stringify(r.messages || [])); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (zoomRef.current) setZoomSrc(''); else onClose(); } };
    document.addEventListener('keydown', onKey, true);          // capture so the grid keys stay inert; Esc closes the lightbox first
    return () => document.removeEventListener('keydown', onKey, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (list: ChatMsg[]) => { setMsgs(list); onSync(JSON.stringify(list)); };
  const send = async () => {
    const t = draft.trim();
    if (!t || busy || readOnly) return;
    setBusy(true);
    try {
      const res = await api.post<{ messages: ChatMsg[] }>(`/api/interviews/rows/${rowId}/chat`, { text: t });
      apply(res.messages || []);
      setDraft(''); taRef.current?.focus();
    } catch (e: any) { toast(e?.response?.data?.detail || 'Failed to send', 'error'); }
    finally { setBusy(false); }
  };
  const del = async (id: string) => {
    try { const res = await api.delete<{ messages: ChatMsg[] }>(`/api/interviews/rows/${rowId}/chat/${id}`); apply(res.messages || []); }
    catch (e: any) { toast(e?.response?.data?.detail || 'Failed to delete', 'error'); }
  };
  const uploadImage = async (blob: File | Blob, caption: string) => {   // paste a screenshot or attach an image
    if (busy || readOnly) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', blob, (blob as any).name || 'screenshot.png');
      if (caption) fd.append('text', caption);
      const res: any = await api.raw.post(`/api/interviews/rows/${rowId}/chat/image`, fd);
      apply(res.data?.messages || []);
      setDraft(''); taRef.current?.focus();
    } catch (e: any) { toast(e?.response?.data?.detail || 'Failed to send image', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="iv-modal-backdrop" onMouseDown={onClose}>
      <div className="iv-modal iv-chat" onMouseDown={(e) => e.stopPropagation()}>
        <div className="iv-modal-hd">
          <div style={{ minWidth: 0 }}>
            <div className="iv-modal-title">{title}</div>
            {subtitle ? <div className="iv-modal-sub" title={subtitle}>{subtitle}</div> : null}
          </div>
          <button className="ghost iv-modal-x" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="iv-chat-list" ref={listRef}>
          {msgs.length === 0 && <div className="iv-chat-empty muted">No messages yet.<br />Share the chat history, interview feedback, or a recording link below.</div>}
          {msgs.map((m) => {
            const mine = !!meName && m.author === meName;
            const canDel = !readOnly && m.id !== 'legacy' && (mine || isAdmin);
            return (
              <div key={m.id} className={'iv-chat-msg' + (mine ? ' mine' : '')}>
                {m.avatar
                  ? <img className="iv-chat-av" src={m.avatar} alt="" />
                  : <span className="iv-chat-av iv-chat-av--i">{initials(m.author || '') || '•'}</span>}
                <div className="iv-chat-bubble">
                  {(m.author || mine) && <div className="iv-chat-author">{mine ? 'You' : m.author}</div>}
                  {m.image && <ChatImage url={m.image} onZoom={setZoomSrc} />}
                  {m.text && <div className="iv-chat-text">{linkify(m.text).map((p, i) => typeof p === 'string'
                    ? <span key={i}>{p}</span>
                    : <a key={i} href={toHref(p.url)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{p.url}</a>)}</div>}
                  <div className="iv-chat-meta">
                    <span title={tz ? `Time zone: ${tz}` : undefined}>{tsInTz(m.at, tz)}</span>
                    {canDel && <button className="iv-chat-del" title="Delete message" onClick={() => del(m.id)}>✕</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {readOnly ? (
          <div className="iv-chat-composer"><span className="muted" style={{ fontSize: '0.78rem', padding: '4px 2px' }}>You have read-only access to this thread.</span></div>
        ) : (
          <div className="iv-chat-composer-wrap">
            <div className="iv-chat-as">
              {me?.avatar_url ? <img className="iv-chat-av iv-chat-av--sm" src={me.avatar_url} alt="" /> : <span className="iv-chat-av iv-chat-av--sm iv-chat-av--i">{initials(meName) || '•'}</span>}
              <span className="muted" style={{ fontSize: '0.72rem' }}>Posting as {meName || 'you'} · 📎 or paste a screenshot to attach an image</span>
            </div>
            <div className="iv-chat-composer">
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" ref={fileRef} style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f, draft.trim()); e.currentTarget.value = ''; }} />
              <button className="iv-chat-attach" title="Attach image" disabled={busy} onClick={() => fileRef.current?.click()}>📎</button>
              <textarea ref={taRef} className="iv-chat-input" value={draft} placeholder="Message — chat history, feedback, or a recording link…  (Enter to send)"
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => { const items = e.clipboardData?.items; if (!items) return; for (const it of Array.from(items)) { if (it.type.startsWith('image/')) { const b = it.getAsFile(); if (b) { e.preventDefault(); uploadImage(b, draft.trim()); return; } } } }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button className="iv-chat-send" disabled={busy || !draft.trim()} onClick={send} title="Send (Enter)">{busy ? '…' : '➤'}</button>
            </div>
          </div>
        )}
      </div>
      {zoomSrc && (
        <div className="iv-lightbox" onMouseDown={(e) => { e.stopPropagation(); setZoomSrc(''); }}>
          <img src={zoomSrc} alt="attachment" onMouseDown={(e) => e.stopPropagation()} />
          <button className="iv-lightbox-x" title="Close (Esc)" onClick={(e) => { e.stopPropagation(); setZoomSrc(''); }}>✕</button>
        </div>
      )}
    </div>
  );
}

function CellEditor({ col, value, editing, seed, avatar, tz, onCommit, onDone, onOpen }: CellProps) {
  if (col.id === 'c_resume') return <ResumeCell value={value} editing={editing} seed={seed} onCommit={onCommit} onDone={onDone} />;   // Resume → downloadable link
  switch (col.type) {
    case 'select': return <SelectCell col={col} value={value} editing={editing} seed={seed} onCommit={onCommit} onDone={onDone} onOpen={onOpen} />;
    case 'person': return <PersonCell value={value} editing={editing} seed={seed} avatar={avatar} onCommit={onCommit} onDone={onDone} />;
    case 'url': return <LinkCell value={value} editing={editing} seed={seed} onCommit={onCommit} onDone={onDone} />;
    case 'file': return <FileCell value={value} editing={editing} seed={seed} onCommit={onCommit} onDone={onDone} />;
    case 'button': return <ButtonCell col={col} value={value} onOpen={onOpen} />;
    case 'checkbox': return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 8px', minHeight: 32 }}><input type="checkbox" checked={!!value} onMouseDown={stop} onChange={(e) => onCommit(e.target.checked)} /></div>;
    case 'date': return <DateCell value={value} editing={editing} tz={tz} onCommit={onCommit} onDone={onDone} />;
    default: return <TextCell col={col} value={value} editing={editing} onCommit={onCommit} onDone={onDone} />;
  }
}

/** One merged cell rendered from a list of sub-fields laid out in two visual rows (the top row may
    be split into left|right). Each sub-field is individually selectable + editable; the grid owns
    selection (subState) and editing (editSub). */
function StackedCell({ fields, row, subState, editSub, editSeed, meName, avatarByName, tz, onSelect, onEdit, onDone, onOpenModal, commit }: {
  fields: { col: Col; sub: number; row: 0 | 1; width?: number }[];
  row: Row; subState: SubState[]; editSub: number | null; editSeed?: string;
  meName?: string; avatarByName?: Record<string, string>; tz?: string;
  onSelect: (sub: number, openType: boolean, shift: boolean) => void;
  onEdit: (sub: number) => void;
  onDone: (dir?: Dir) => void;
  onOpenModal?: (col: Col) => void;
  commit: (colId: string, v: any) => void;
}) {
  const cellFor = (f: { col: Col; sub: number; width?: number }) => {
    const { col, sub } = f;
    const isSelect = col.type === 'select';
    // There is no Team column on the board — the Caller cell IS the assignment. Until a person is
    // picked it shows the team the call was handed to, so a team-assigned row never looks blank.
    const value = (col.id === 'c_caller' && !row.cells?.c_caller)
      ? (row.cells?.c_team ?? '')
      : row.cells?.[col.id];
    const empty = value === '' || value === null || value === undefined;
    const h: Record<string, any> = {
      onMouseDown: (e: ReactMouseEvent) => { if (e.button !== 0) return; e.stopPropagation(); onSelect(sub, false, e.shiftKey); },  // body click = select (Shift = extend)
    };
    // click an empty Created_at / Creater cell (once the row's Index is set) to stamp now / current user
    if (!isSelect && AUTO_NOW_COLS.has(col.id) && empty && rowIndexSet(row)) h.onClick = (e: ReactMouseEvent) => { e.stopPropagation(); commit(col.id, nowLocal()); };
    else if (AUTO_ME_COLS.has(col.id) && empty && !!meName && rowIndexSet(row)) h.onClick = (e: ReactMouseEvent) => { e.stopPropagation(); commit(col.id, meName); };
    else h.onDoubleClick = (e: ReactMouseEvent) => { e.stopPropagation(); onEdit(sub); };   // double-click edits / opens
    const st = subState[sub];
    const selStyle: CSSProperties = st === 'anchor' ? { boxShadow: `inset 0 0 0 2px ${SEL}` } : st === 'fill' ? { background: '#15212e' } : {};
    return (
      <div key={f.sub} className={'iv-subcell' + (sub !== 0 ? ' iv-sub' : '')} style={{ flex: f.width ? `0 0 ${f.width}px` : 1, minWidth: 0, ...selStyle }} {...h}>
        <CellEditor col={col} value={value} editing={editSub === sub} seed={editSub === sub ? editSeed : undefined} tz={tz}
          avatar={col.type === 'person' ? avatarByName?.[String(value ?? '')] : undefined}
          onCommit={(v) => commit(col.id, v)} onDone={onDone}
          onOpen={col.type === 'button' ? () => onOpenModal?.(col) : (isSelect ? () => onEdit(sub) : undefined)} />
      </div>
    );
  };
  const top = fields.filter((f) => f.row === 0);
  const bot = fields.filter((f) => f.row === 1);
  return (
    <div className="iv-stack">
      <div className="iv-stack-row">
        {top.flatMap((f, i) => (i > 0 ? [<div key={`v${f.sub}`} className="iv-stack-vdiv" />, cellFor(f)] : [cellFor(f)]))}
      </div>
      {bot.length > 0 && <div className="iv-stack-div" />}
      {bot.length > 0 && <div className="iv-stack-row">{bot.map((f) => cellFor(f))}</div>}
    </div>
  );
}

/** Notion's fixed color menu — pick one of the 9 documented tokens. */
function SwatchPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const cur = resolveNotion(value);
  return (
    <div ref={ref} style={{ position: 'relative', flex: '0 0 auto' }}>
      <button type="button" title="Pill color" onClick={() => setOpen((o) => !o)}
        style={{ width: 24, height: 24, borderRadius: 4, border: '1px solid rgba(255,255,255,0.15)', background: cur.bg, cursor: 'pointer', padding: 0 }}>
        <span style={{ display: 'block', width: 10, height: 10, borderRadius: '50%', background: cur.text, margin: '0 auto' }} />
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', top: '112%', left: 0, zIndex: 70, padding: 8, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, width: 178 }}>
          {NOTION_LIST.map((c) => (
            <button key={c.text} type="button" title={c.text} onClick={() => { onChange(c.text); setOpen(false); }}
              style={{ width: 26, height: 26, borderRadius: 5, padding: 0, cursor: 'pointer', background: c.bg,
                border: cur.text === c.text ? '2px solid #2383e2' : '1px solid rgba(255,255,255,0.12)' }}>
              <span style={{ display: 'block', width: 11, height: 11, borderRadius: '50%', background: c.text, margin: '0 auto' }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OptionsEditor({ options, onChange }: { options: Opt[]; onChange: (o: Opt[]) => void }) {
  const setAt = (i: number, patch: Partial<Opt>) => onChange(options.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  const remove = (i: number) => onChange(options.filter((_, idx) => idx !== i));
  const add = () => onChange([...options, { label: 'New', color: PALETTE[options.length % PALETTE.length] }]);
  return (
    <div>
      {options.map((o, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
          <SwatchPicker value={o.color} onChange={(color) => setAt(i, { color })} />
          <input defaultValue={o.label} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== o.label) setAt(i, { label: v }); }} style={{ flex: 1 }} />
          <button className="ghost" onClick={() => remove(i)} style={{ padding: '0 6px' }}>✕</button>
        </div>
      ))}
      <button className="secondary" style={{ width: '100%', fontSize: '0.8rem', marginTop: 2 }} onClick={add}>+ Option</button>
    </div>
  );
}

/** "GMT+9" / "GMT+3" / "GMT+5:30" — the UTC offset of a zone, so the Scheduled_at column can say
   which timezone its times are shown in (the one picked in account settings). */
function tzLabel(tz?: string): string {
  const off = tzOffsetMin(new Date(), tz);                 // minutes east of UTC
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off), h = Math.floor(abs / 60), m = abs % 60;
  return `GMT${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

function ColumnHead({ col, subLabel, subExtra, topExtra, admin, optionFields, onPatch, onDelete, onResize, onResizeEnd, onFieldPatch }: {
  col: Col; subLabel?: string; subExtra?: string; topExtra?: { label: string; icon?: string; text?: string }[];
  admin?: boolean; optionFields?: { colId: string; name: string; options: Opt[] }[];
  onPatch: (p: Partial<Col>) => void; onDelete: () => void;
  onResize: (w: number) => void; onResizeEnd: () => void;
  onFieldPatch: (colId: string, patch: Partial<Col>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const locked = LOCKED_COLS.has(col.id);
  const hasMenu = !!admin && (!locked || (!!optionFields && optionFields.length > 0));   // admin: edit options even on locked cols
  const dragRef = useRef<(() => void) | null>(null);     // active-drag teardown (no commit)
  useEffect(() => () => dragRef.current?.(), []);         // tear down a drag if we unmount mid-drag
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault(); e.stopPropagation();              // don't open the column menu / select text
    const startX = e.clientX;
    const startW = col.width || DEFAULT_W;
    let moved = false;
    const move = (ev: MouseEvent) => { moved = true; onResize(Math.max(MIN_W, Math.min(MAX_W, startW + (ev.clientX - startX)))); };
    const endDrag = (commit: boolean) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      window.removeEventListener('blur', cancel);
      document.body.classList.remove('iv-col-resizing');
      dragRef.current = null;
      if (commit && moved) onResizeEnd();                 // persist only a real, in-bounds drag
    };
    const up = () => endDrag(true);
    const cancel = () => endDrag(true);                   // window blur / lost mouseup → commit what we have, self-heal the body class
    dragRef.current = () => endDrag(false);               // unmount → tear down WITHOUT setState/PUT
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    window.addEventListener('blur', cancel);
    document.body.classList.add('iv-col-resizing');
  };
  return (
    <th className="iv-hd">
      <div ref={ref} style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {topExtra && topExtra.length ? (
            <span className="iv-hd-name-row">
              <span className="iv-hd-name" style={{ flex: 1, minWidth: 0 }}>{col.name}</span>
              {topExtra.map((t, i) => (
                <span key={i} className="iv-hd-tr" title={t.label}>
                  {t.icon && <span className="iv-hd-icon">{t.icon}</span>}
                  {t.icon ? (t.text ? <span style={{ marginLeft: 3 }}>{t.text}</span> : null) : t.label}
                </span>
              ))}
            </span>
          ) : (
            <span className="iv-hd-name">{col.name}</span>
          )}
          {(subLabel || subExtra) && (
            <span className="iv-hd-sub-row">
              <span className="iv-hd-sub">{subLabel}</span>
              {subExtra && <span className="iv-hd-tz" title="Times in this column are shown in your account-settings timezone">{subExtra}</span>}
            </span>
          )}
        </span>
        {hasMenu && <button className="ghost iv-hd-btn" style={{ padding: '0 5px' }} onClick={() => setOpen((o) => !o)} title="Column settings">⋯</button>}
        {open && hasMenu && (
          <div className="card" style={{ position: 'absolute', top: '100%', right: 0, zIndex: 60, width: 250, padding: 10, maxHeight: 400, overflowY: 'auto' }}>
            {!locked && (
              <>
                <div className="field" style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: '0.7rem' }}>Name</label>
                  <input defaultValue={col.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== col.name) onPatch({ name: v }); }} style={{ width: '100%' }} />
                </div>
                <div className="field" style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: '0.7rem' }}>Type</label>
                  <select value={col.type} onChange={(e) => onPatch({ type: e.target.value })} style={{ width: '100%' }}>
                    {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </>
            )}
            {(optionFields || []).map((f) => (
              <div className="field" key={f.colId} style={{ marginBottom: 8 }}>
                <label style={{ fontSize: '0.7rem' }}>{f.name} options</label>
                <OptionsEditor options={f.options} onChange={(options) => onFieldPatch(f.colId, { options })} />
              </div>
            ))}
            {!locked && <button className="danger" style={{ width: '100%' }} onClick={() => { onDelete(); setOpen(false); }}>Delete column</button>}
          </div>
        )}
      </div>
      {admin && <div className="iv-resize" onMouseDown={startResize} title="Drag to resize" />}
    </th>
  );
}

/* Turn OS (Windows) notifications on/off for this device: interview assignments, time/content
   changes, and the 7pm-day-before / 8am-day-of / 1h-before reminders. Delivered by Web Push, so
   they still arrive when the board tab is closed (as long as the browser is running). */
function NotifBell() {
  const toast = useToast();
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() => notifPermission());
  const [busy, setBusy] = useState(false);
  // A returning user who already granted permission gets their subscription re-registered silently,
  // so the server always has a live endpoint to push to. initPushSound lets the service worker ask
  // this page to chime — Windows often mutes the toast sound for Chrome, and a SW can't play audio.
  useEffect(() => { initPushSound(); void syncPushIfGranted(); }, []);

  if (!pushSupported()) return null;

  const enable = async () => {
    setBusy(true);
    try {
      const r = await enablePush();
      setPerm(notifPermission());
      if (r.ok) { toast('Notifications enabled', 'success'); try { await sendTestPush(); } catch { /* ignore */ } }
      else toast(r.reason || 'Could not enable notifications', 'error');
    } catch {
      toast('Could not enable notifications', 'error');
    } finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true);
    try { await disablePush(); toast('Notifications turned off for this device', 'success'); }
    finally { setPerm(notifPermission()); setBusy(false); }
  };

  return perm === 'granted'
    ? <button className="secondary" disabled={busy} onClick={disable}
        title="Interview alerts and reminders are ON for this device — click to turn off">🔔 Notifications on</button>
    : <button className="secondary" disabled={busy} onClick={enable}
        title="Get interview assignments, time changes and reminders as desktop notifications">🔔 Enable notifications</button>;
}

export default function Interviews() {
  const toast = useToast();
  const { user: me } = useAuth();
  // Pick the column layout for this session's role before render / listeners use it: callers see a
  // combined Approved/Status column in place of the admin-only Caller & Creater columns; a team
  // manager sees that same board plus the Caller column, so they can hand a call to a team-mate.
  // `L.MERGED` and `L.STACK_HIDDEN` are stable per-session objects, so aliasing them is render-safe.
  const isTeamManager = !me?.is_admin && (me?.roles || []).includes('manager');
  // A caller who's on a team sees the team's whole schedule, so they get the same board as their
  // manager — the Caller column included, or they couldn't tell whose call is whose. The only
  // difference is what they may change: the manager can re-assign the Caller, they cannot (and they
  // can only touch their OWN rows at all — see canEditCell).
  const isTeamCaller = !me?.is_admin && !isTeamManager && !!String(me?.team_id || '').trim();
  L = me?.is_admin ? ADMIN_LAYOUT : (isTeamManager || isTeamCaller) ? MANAGER_LAYOUT : CALLER_LAYOUT;
  const { MERGED, STACK_HIDDEN } = L;
  const [grid, setGrid] = useState<Grid | null>(null);
  const [people, setPeople] = useState<{ label: string; roles?: string[]; team_id?: string; avatar_url?: string }[]>([]);   // all users (Caller dropdown + Creater avatars)
  const [profiles, setProfiles] = useState<{ id: string; name: string; label: string }[]>([]);            // Profiles tab / DB (Account Profile dropdown)
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);                                 // caller teams (Team dropdown)
  const [loading, setLoading] = useState(true);
  const [flt, setFlt] = useState<Record<string, string>>({});      // filter bar: 'q' → search text; dateFrom/dateTo → Scheduled_at range
  const [colFlt, setColFlt] = useState<Record<string, string[]>>({});  // per-column multi-select (checkable) filters
  const [limit, setLimit] = useState(50);                          // show the recent N schedules (0 = all)
  const gridRef = useRef<Grid | null>(null);
  // gridRef is set during render to the FILTERED grid (see below) so keyboard + clipboard operate on visible rows.

  // ── cell selection (Coda/Sheets-style): click = select one cell, double-click = edit, drag = range,
  //    Delete/Backspace = clear. Stacked columns: each sub-cell selects/edits independently. ──
  const [sel, setSel] = useState<{ r1: number; c1: number; r2: number; c2: number } | null>(null);
  const [aSub, setASub] = useState<number>(0);                // which sub-field of the anchor cell is selected
  const [editing, setEditing] = useState<{ r: number; c: number; s: number; seed?: string } | null>(null);
  const [copied, setCopied] = useState<SelRect | null>(null);  // copy-highlight, cleared on paste / Escape / new copy
  const [modal, setModal] = useState<{ rowId: string; colId: string; title: string; subtitle: string; value: string; readOnly: boolean; kind: 'text' | 'chat' } | null>(null);  // JD editor / Chat thread
  const [confirmDel, setConfirmDel] = useState<string | null>(null);   // rowId pending delete-confirmation
  const [flashRow, setFlashRow] = useState<string | null>(null);       // row just re-sorted by a Scheduled_at edit → scroll to + flash it
  // The "next upcoming call" highlight is derived from Date.now() at render time. Tick every minute
  // so that when the next call passes, the yellow moves on to the following one by itself — no
  // manual refresh needed.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setClockTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const dragging = useRef(false);
  const anchor = useRef<{ r: number; c: number } | null>(null);
  const selRef = useRef(sel); useEffect(() => { selRef.current = sel; }, [sel]);
  const aSubRef = useRef(aSub); useEffect(() => { aSubRef.current = aSub; }, [aSub]);
  const editingRef = useRef(editing); useEffect(() => { editingRef.current = editing; }, [editing]);
  const modalRef = useRef<unknown>(modal); useEffect(() => { modalRef.current = modal || confirmDel; }, [modal, confirmDel]);   // grid keys/clipboard inert while ANY overlay (editor or confirm) is open
  const toastRef = useRef(toast); useEffect(() => { toastRef.current = toast; }, [toast]);
  const effColsRef = useRef<Record<string, Col>>({});         // effective columns (incl. injected Caller options) for the codec
  const canEditRef = useRef<(colId: string) => boolean>(() => true);   // per-column write permission (callers are limited) for once-bound listeners
  const moveActiveRef = useRef<(dir: Dir, extend: boolean) => void>(() => {});
  const fillRef = useRef<(dir: 'down' | 'right') => void>(() => {});
  const anchorTdRef = useRef<HTMLTableCellElement | null>(null);
  useEffect(() => { anchorTdRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [sel]);  // keep the active cell in view
  // A Scheduled_at edit re-sorts the board, so the edited row jumps to its new chronological spot.
  // Scroll it back into view + let the flash highlight (see .iv-row--flash) run, then clear the marker.
  useEffect(() => {
    if (!flashRow) return;
    document.querySelector(`tr[data-rid="${flashRow}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const t = window.setTimeout(() => setFlashRow(null), 1500);
    return () => window.clearTimeout(t);
  }, [flashRow]);
  useEffect(() => {
    const up = () => { dragging.current = false; };
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, []);
  // Keyboard on a selected cell (Notion/Sheets): arrows + Tab move the active cell; Delete/Backspace
  // clears; Enter/F2 edits keeping the value; typing any character starts editing seeded with it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalRef.current) return;                                       // JD/Feedback modal is open → grid keys inert
      if (editingRef.current) return;                                     // the editor owns its own keys
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;        // typing in a field
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); (e.shiftKey ? redoRef : undoRef).current(); return; }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoRef.current(); return; }
      const s = selRef.current, g = gridRef.current;
      if (!s || !g) return;
      const vis = g.columns.filter((c) => !STACK_HIDDEN.has(c.id));
      const ncols = vis.length, nrows = g.rows.length;

      // ── navigation: arrows step through sub-fields; Shift+Arrow extends the range; Tab wraps rows ──
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActiveRef.current('down', e.shiftKey); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveActiveRef.current('up', e.shiftKey); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); moveActiveRef.current('right', e.shiftKey); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); moveActiveRef.current('left', e.shiftKey); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        let nc = s.c1 + (e.shiftKey ? -1 : 1), nr = s.r1;
        if (nc < 0) { nc = ncols - 1; nr = Math.max(0, s.r1 - 1); }
        else if (nc > ncols - 1) { nc = 0; nr = Math.min(nrows - 1, s.r1 + 1); }
        setSel({ r1: nr, c1: nc, r2: nr, c2: nc }); setASub(0);
        return;
      }
      if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); if (nrows && ncols) { setSel({ r1: 0, c1: 0, r2: nrows - 1, c2: ncols - 1 }); setASub(0); } return; }
      if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); fillRef.current('down'); return; }
      if (mod && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); fillRef.current('right'); return; }
      if (e.key === 'Escape') { setCopied(null); return; }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const asub = aSubRef.current;
        const rmin = Math.min(s.r1, s.r2), rmax = Math.max(s.r1, s.r2);
        const cmin = Math.min(s.c1, s.c2), cmax = Math.max(s.c1, s.c2);
        const isBtn = (cid: string) => g.columns.find((cc) => cc.id === cid)?.type === 'button';   // Job Description / Chat are modal-managed — Delete must not wipe them
        const clearable = (cid: string) => canEditRef.current(cid) && !isBtn(cid);
        const changes: { rowId: string; colId: string; value: any }[] = [];
        for (let r = rmin; r <= rmax; r++) {
          const row = g.rows[r];
          if (!row) continue;
          for (let c = cmin; c <= cmax; c++) {
            const col = vis[c];
            if (!col) continue;
            const fields = MERGED[col.id];
            if (fields) { for (const sub of subsOf(s, asub, r, c, fields.map((f) => f.row))) { const cid = fields[sub].colId; if (clearable(cid)) changes.push({ rowId: row.id, colId: cid, value: '' }); } }
            else if (clearable(col.id)) changes.push({ rowId: row.id, colId: col.id, value: '' });
          }
        }
        recordRef.current(changes);
        return;
      }
      // resolve the column the active sub-field actually edits (merged → its field's column)
      const c0 = s.c1, sub0 = aSubRef.current;
      const acol = vis[c0];
      const afields = acol ? MERGED[acol.id] : null;
      const tcol = afields ? g.columns.find((c) => c.id === afields[sub0]?.colId) : acol;
      const editable = !!tcol && tcol.type !== 'button' && tcol.type !== 'checkbox' && canEditRef.current(tcol.id);

      if ((e.key === 'Enter' || e.key === 'F2') && editable) {            // edit the active cell, keep its value
        e.preventDefault();
        setEditing({ r: s.r1, c: s.c1, s: aSubRef.current });
        return;
      }
      if (editable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {  // typing → edit, seeded with the char
        e.preventDefault();
        setEditing({ r: s.r1, c: s.c1, s: aSubRef.current, seed: e.key });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Ctrl/Cmd+V into the selected cell(s): a single value fills the selection; a tab/newline grid
  // spills from the anchor. Each target cell uses its selected sub (stacked → primary or secondary).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (modalRef.current) return;                                       // modal open → don't paste into the hidden grid
      if (editingRef.current) return;                                     // let an open editor paste normally
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const s = selRef.current, g = gridRef.current;
      if (!s || !g) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      e.preventDefault();
      setCopied(null);
      const vis = g.columns.filter((c) => !STACK_HIDDEN.has(c.id));
      const nrows = g.rows.length, asub = aSubRef.current;
      const logi = logicalCols(vis);
      const logAt = (c: number, sub: number) => logi.findIndex((x) => x.c === c && x.sub === sub);
      const colOf = (colId: string) => effColsRef.current[colId] || g.columns.find((cc) => cc.id === colId);
      const matrix = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n').map((ln) => ln.split('\t'));
      const single = matrix.length === 1 && matrix[0].length === 1;
      const changes: { rowId: string; colId: string; value: any }[] = [];
      const put = (r: number, li: number, str: string) => {           // write a TSV string into logical cell (r, li), typed
        if (r < 0 || r >= nrows || li < 0 || li >= logi.length) return;
        const row = g.rows[r]; if (!row) return;
        const lc = logi[li];
        if (!canEditRef.current(lc.colId)) return;                    // skip read-only columns (caller)
        changes.push({ rowId: row.id, colId: lc.colId, value: parseCell(colOf(lc.colId), str, row.cells?.[lc.colId] ?? '') });
      };
      const rmin = Math.min(s.r1, s.r2), rmax = Math.max(s.r1, s.r2);
      const cmin = Math.min(s.c1, s.c2), cmax = Math.max(s.c1, s.c2);
      if (single && (rmin !== rmax || cmin !== cmax)) {                 // one value → fill the whole selection
        const v = matrix[0][0];
        for (let r = rmin; r <= rmax; r++) for (let c = cmin; c <= cmax; c++) {
          const fields = MERGED[vis[c]?.id];
          const subs = fields ? subsOf(s, asub, r, c, fields.map((f) => f.row)) : [0];
          for (const sub of subs) put(r, logAt(c, sub), v);
        }
      } else {                                                          // a grid spills from the selection's top-left logical cell
        // (matches how copy serialises: cmin/rmin origin, sub 0 first). A lone value dropped on one
        // (possibly sub-)cell targets exactly the clicked sub so round-trips + sub-paste both stay aligned.
        const start = single ? logAt(s.c1, asub) : logAt(cmin, 0);
        const originR = single ? s.r1 : rmin;
        for (let i = 0; i < matrix.length; i++) for (let j = 0; j < matrix[i].length; j++)
          put(originR + i, start + j, matrix[i][j]);
      }
      recordRef.current(changes);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  // Ctrl/Cmd+C copy, Ctrl/Cmd+X cut — serialise every selected cell (any type) to TSV + an HTML table.
  useEffect(() => {
    const guard = (e: ClipboardEvent) => {
      if (modalRef.current) return false;                                 // modal open → grid copy/cut inert
      if (editingRef.current) return false;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return false;
      return !!(selRef.current && gridRef.current);
    };
    const build = () => {
      const s = selRef.current!, g = gridRef.current!, asub = aSubRef.current;
      const vis = g.columns.filter((c) => !STACK_HIDDEN.has(c.id));
      const colOf = (colId: string) => effColsRef.current[colId] || g.columns.find((cc) => cc.id === colId);
      const rmin = Math.min(s.r1, s.r2), rmax = Math.max(s.r1, s.r2), cmin = Math.min(s.c1, s.c2), cmax = Math.max(s.c1, s.c2);
      const rows: string[][] = [];
      if (rmin === rmax && cmin === cmax) {                            // single cell → just its selected sub-field
        const col = vis[cmin]; const ids = fieldIdsOf(col); const colId = ids[asub] ?? col.id;
        rows.push([serializeCell(colOf(colId), g.rows[rmin]?.cells?.[colId])]);
      } else {
        const logi = logicalCols(vis).filter((x) => x.c >= cmin && x.c <= cmax);
        for (let r = rmin; r <= rmax; r++) {
          const row = g.rows[r]; const cells: string[] = [];
          for (const lc of logi) {
            const fields = MERGED[vis[lc.c].id];
            const isSel = fields ? subsOf(s, asub, r, lc.c, fields.map((f) => f.row)).includes(lc.sub) : true;
            cells.push(isSel ? serializeCell(colOf(lc.colId), row?.cells?.[lc.colId]) : '');
          }
          rows.push(cells);
        }
      }
      const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return { tsv: rows.map((r) => r.join('\t')).join('\n'),
               html: '<table>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') + '</table>',
               rect: { r1: rmin, c1: cmin, r2: rmax, c2: cmax } };
    };
    const write = (e: ClipboardEvent, b: { tsv: string; html: string }) => {
      e.clipboardData?.setData('text/plain', b.tsv);
      e.clipboardData?.setData('text/html', b.html);
      e.preventDefault();
    };
    const onCopy = (e: ClipboardEvent) => { if (!guard(e)) return; const b = build(); write(e, b); setCopied(b.rect); };
    const onCut = (e: ClipboardEvent) => {
      if (!guard(e)) return;
      const b = build(); write(e, b);
      const s = selRef.current!, g = gridRef.current!, asub = aSubRef.current;
      const vis = g.columns.filter((c) => !STACK_HIDDEN.has(c.id));
      const rmin = Math.min(s.r1, s.r2), rmax = Math.max(s.r1, s.r2), cmin = Math.min(s.c1, s.c2), cmax = Math.max(s.c1, s.c2);
      const isBtn = (colId: string) => g.columns.find((cc) => cc.id === colId)?.type === 'button';   // cut copies '' for buttons → don't clear them
      const clearable = (colId: string) => !isBtn(colId) && canEditRef.current(colId);              // and never clear a read-only column
      const changes: { rowId: string; colId: string; value: any }[] = [];
      for (let r = rmin; r <= rmax; r++) { const row = g.rows[r]; if (!row) continue; for (let c = cmin; c <= cmax; c++) { const col = vis[c]; if (!col) continue; const fields = MERGED[col.id]; if (fields) { for (const sub of subsOf(s, asub, r, c, fields.map((f) => f.row))) { const cid = fields[sub].colId; if (clearable(cid)) changes.push({ rowId: row.id, colId: cid, value: '' }); } } else if (clearable(col.id)) changes.push({ rowId: row.id, colId: col.id, value: '' }); } }
      recordRef.current(changes); setCopied(null);
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    return () => { document.removeEventListener('copy', onCopy); document.removeEventListener('cut', onCut); };
  }, []);

  useEffect(() => {
    api.get<Grid>('/api/interviews').then((g) => setGrid(orderColumns(g))).catch(() => toast('Failed to load interviews', 'error')).finally(() => setLoading(false));
    api.get<{ people: { label: string; roles?: string[]; team_id?: string; avatar_url?: string }[] }>('/api/interviews/people').then((r) => setPeople(r.people || [])).catch(() => {});
    api.get<{ profiles: { id: string; name: string; label: string }[] }>('/api/interviews/profiles').then((r) => setProfiles(r.profiles || [])).catch(() => {});
    // Teams feed the Team dropdown. The API already scopes this: an admin gets every team, a manager
    // only their own — so a manager can never hand a call to another team.
    api.get<{ id: string; name: string }[]>('/api/teams').then((r) => setTeams(r || [])).catch(() => {});
  }, []);

  const saveSchema = async (columns: Col[]) => {
    setGrid((g) => (g ? { ...g, columns } : g));
    try { const res = await api.put<Grid>('/api/interviews/schema', { columns }); setGrid(orderColumns(res)); }
    catch { toast('Failed to save columns', 'error'); }
  };
  // Live (local-only) width update while dragging; persisted once on mouse-up.
  const setColWidth = (id: string, width: number) =>
    setGrid((g) => (g ? { ...g, columns: g.columns.map((c) => (c.id === id ? { ...c, width } : c)) } : g));
  const patchColumn = (id: string, patch: Partial<Col>) => grid && saveSchema(grid.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const deleteColumn = (id: string) => { if (grid && confirm('Delete this column and its data?')) saveSchema(grid.columns.filter((c) => c.id !== id)); };

  // ── undo / redo (Ctrl+Z / Ctrl+Y) over cell edits, paste, clear, and row add/delete ──
  type CellChange = { rowId: string; colId: string; value: any };
  type Op = { k: 'cells'; forward: CellChange[]; inverse: CellChange[] } | { k: 'addRow'; row: Row; at: number } | { k: 'delRow'; row: Row; at: number };
  const undoStack = useRef<Op[]>([]);
  const redoStack = useRef<Op[]>([]);
  const writeCells = (list: CellChange[]) => {           // apply cell values (local + server), no undo record
    if (!list.length) return;
    const byRow: Record<string, Record<string, any>> = {};
    for (const ch of list) (byRow[ch.rowId] = byRow[ch.rowId] || {})[ch.colId] = ch.value;
    setGrid((g) => (g ? { ...g, rows: g.rows.map((r) => (byRow[r.id] ? { ...r, cells: { ...r.cells, ...byRow[r.id] } } : r)) } : g));
    Object.keys(byRow).forEach((rowId) => api.patch(`/api/interviews/rows/${rowId}`, { cells: byRow[rowId] }).catch(() => toastRef.current('Failed to save', 'error')));
  };
  const recordCells = (list: CellChange[]) => {          // the public cell-commit: writes + records an undo step
    const g = gridRef.current;
    const real = list.filter((ch) => g?.rows.some((r) => r.id === ch.rowId));
    if (!g || !real.length) return;
    const inverse = real.map((ch) => { const row = g.rows.find((r) => r.id === ch.rowId); return { rowId: ch.rowId, colId: ch.colId, value: row?.cells?.[ch.colId] ?? '' }; });
    writeCells(real);
    undoStack.current.push({ k: 'cells', forward: real, inverse });
    if (undoStack.current.length > 200) undoStack.current.shift();
    redoStack.current = [];
  };
  const insertRowOp = (row: Row, at: number) => {        // re-insert a row (undo of delete / redo of add)
    setGrid((g) => { if (!g) return g; const rows = [...g.rows]; rows.splice(Math.max(0, Math.min(at, rows.length)), 0, row); return { ...g, rows }; });
    api.post('/api/interviews/rows', { id: row.id, at, cells: row.cells }).catch(() => toastRef.current('Failed to restore row', 'error'));
  };
  const removeRowOp = (rowId: string) => {               // delete a row (undo of add / redo of delete)
    setGrid((g) => (g ? { ...g, rows: g.rows.filter((r) => r.id !== rowId) } : g));
    api.delete(`/api/interviews/rows/${rowId}`).catch(() => toastRef.current('Failed to remove row', 'error'));
  };
  const undo = () => {
    const op = undoStack.current.pop(); if (!op) return;
    if (op.k === 'cells') writeCells(op.inverse);
    else if (op.k === 'addRow') removeRowOp(op.row.id);
    else if (op.k === 'delRow') insertRowOp(op.row, op.at);
    redoStack.current.push(op);
  };
  const redo = () => {
    const op = redoStack.current.pop(); if (!op) return;
    if (op.k === 'cells') writeCells(op.forward);
    else if (op.k === 'addRow') insertRowOp(op.row, op.at);
    else if (op.k === 'delRow') removeRowOp(op.row.id);
    undoStack.current.push(op);
  };
  const recordRef = useRef(recordCells); recordRef.current = recordCells;   // latest-callback refs for the once-bound listeners
  const undoRef = useRef(undo); undoRef.current = undo;
  const redoRef = useRef(redo); redoRef.current = redo;

  // Callers may write only Approved, Status, and Feedback; admins anything. Backend enforces this too.
  const canEditCol = (colId: string) =>
    !!me?.is_admin || (isTeamManager ? MANAGER_EDITABLE : CALLER_EDITABLE).has(colId);
  canEditRef.current = canEditCol;
  // Row-level rule. A team caller SEES the whole team's schedule but may only write their own calls
  // (the backend 404s on the rest) — without this the UI would happily let them edit a team-mate's
  // Approved/Status and then silently drop it. Admins and the team's manager may write anywhere in
  // scope, so they short-circuit.
  const ownsRow = (row?: Row | null) => {
    if (me?.is_admin || isTeamManager) return true;
    if (!row) return true;                                    // no row context (e.g. a fresh row) → let the server decide
    const c = String(row.cells?.c_caller ?? '').trim().toLowerCase();
    const mineNames = [String(me?.username ?? ''), String(me?.full_name ?? '')]
      .map((s) => s.trim().toLowerCase()).filter(Boolean);
    return mineNames.includes(c);
  };
  const canEditCell = (row: Row | null | undefined, colId: string) => canEditCol(colId) && ownsRow(row);
  const commitCell = (rowId: string, colId: string, value: any) => {
    // read-only column, or someone else's call (a team caller can see team-mates' rows) → ignore
    if (!canEditCell(gridRef.current?.rows.find((r) => r.id === rowId), colId)) return;

    // The Caller dropdown is a tree of teams + people, so a pick from it can mean either thing:
    //   a TEAM   → hand the whole call to that team (set Team, leave Caller empty for the manager)
    //   a CALLER → assign the person, and keep Team pointing at whichever team they belong to
    // Both are written from the one cell the user actually clicked.
    if (colId === 'c_caller') {
      const picked = String(value ?? '').trim();
      if (picked && teamNames.has(picked)) {
        if (!canEditCol('c_team')) return;                 // a manager may not re-team a call
        recordCells([{ rowId, colId: 'c_team', value: picked }, { rowId, colId: 'c_caller', value: '' }]);
        return;
      }
      const owner = picked ? teamOfCaller(picked) : '';
      const changes: CellChange[] = [{ rowId, colId: 'c_caller', value }];
      if (canEditCol('c_team')) changes.push({ rowId, colId: 'c_team', value: owner });
      recordCells(changes);
      return;
    }

    const changes: CellChange[] = [{ rowId, colId, value }];
    // Created_at is hidden (shown on Index hover); stamp it the first time a row's Index is set.
    if (colId === 'c_index' && value !== '' && value != null) {
      const row = gridRef.current?.rows.find((r) => r.id === rowId);
      if (row && !row.cells?.c_created) changes.push({ rowId, colId: 'c_created', value: new Date().toISOString() });
    }
    recordCells(changes);
    // Editing Scheduled_at re-sorts the row to a new position — flag it so the effect above scrolls
    // to + flashes it, making the change (and where the row went) obvious instead of looking unchanged.
    if (colId === 'c_sched') setFlashRow(rowId);
  };
  const addRow = async () => {
    try {
      const rows = grid?.rows ?? [];   // full rows (not the filtered view) so Index numbering is correct
      const at = rows.length;
      // auto-fill the next Index (max existing + 1) and Created_at (now → shown on Index hover)
      const maxIdx = rows.reduce((m, r) => { const n = parseInt(String(r.cells?.c_index ?? ''), 10); return Number.isFinite(n) ? Math.max(m, n) : m; }, 0);
      const row = await api.post<Row>('/api/interviews/rows', { cells: { c_index: String(maxIdx + 1), c_created: new Date().toISOString() } });
      setGrid((g) => (g ? { ...g, rows: [...g.rows, row] } : g));
      undoStack.current.push({ k: 'addRow', row, at }); redoStack.current = [];
    } catch { toast('Failed to add row', 'error'); }
  };
  const deleteRow = async (rowId: string) => {
    const rows = grid?.rows ?? [];   // full rows for a correct undo re-insert position
    const at = rows.findIndex((r) => r.id === rowId);
    const row = at >= 0 ? rows[at] : null;
    setGrid((gg) => (gg ? { ...gg, rows: gg.rows.filter((r) => r.id !== rowId) } : gg));
    setSel(null); setEditing(null);
    try { await api.delete(`/api/interviews/rows/${rowId}`); if (row) { undoStack.current.push({ k: 'delRow', row, at }); redoStack.current = []; } } catch { toast('Failed to delete row', 'error'); }
  };
  // Keep one empty row available by default: if an admin opens an empty board, seed a blank row (once).
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !grid || !me?.is_admin) return;
    if (grid.rows.length === 0) { seededRef.current = true; addRow(); }
  }, [grid, me]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Filtering / limiting changes which rows are visible → drop the selection so it can't point at a now-hidden row.
  useEffect(() => { setSel(null); setEditing(null); setCopied(null); }, [flt, colFlt, limit]);

  const selectCellSub = (r: number, c: number, sub: number, openType: boolean, shift?: boolean) => {
    if (editing && editing.r === r && editing.c === c && editing.s === sub) return;  // already editing this sub
    if (shift && selRef.current) {                               // Shift+click extends from the ACTIVE cell (r1,c1) —
      const s = selRef.current;                                  // same pivot Shift+Arrow uses, so keyboard + mouse agree
      anchor.current = { r: s.r1, c: s.c1 };                     // (arrow/Tab move r1/c1 but not anchor.current, which would be stale)
      dragging.current = true;                                   // allow shift-click-then-drag to keep extending
      setSel({ r1: s.r1, c1: s.c1, r2: r, c2: c });
      return;
    }
    anchor.current = { r, c };
    dragging.current = true;
    setSel({ r1: r, c1: c, r2: r, c2: c });
    setASub(sub);
    setEditing(openType ? { r, c, s: sub } : null);             // dropdown (select) cells open on a single click
  };
  const selectCell = (e: ReactMouseEvent, r: number, c: number, sub: number, openType: boolean) => {
    if (e.button !== 0) return;                                   // left button only
    selectCellSub(r, c, sub, openType, e.shiftKey);
  };
  const extendTo = (r: number, c: number) => {
    if (!dragging.current || !anchor.current) return;
    setSel({ r1: anchor.current.r, c1: anchor.current.c, r2: r, c2: c });
  };
  const editCell = (r: number, c: number, sub: number) => {
    const g = gridRef.current;
    const vis = g ? g.columns.filter((cc) => !STACK_HIDDEN.has(cc.id)) : [];
    const col = vis[c];
    const colId = col ? (fieldIdsOf(col)[sub] ?? col.id) : '';
    if (!canEditCell(g?.rows[r], colId)) return;                 // read-only column, or a team-mate's row
    anchor.current = { r, c };
    setSel({ r1: r, c1: c, r2: r, c2: c });
    setASub(sub);
    setEditing({ r, c, s: sub });
  };
  const openModal = (row: Row, col: Col) => setModal({           // JD / Feedback button → open the long-text editor
    rowId: row.id, colId: col.id, title: col.name,
    subtitle: String(row.cells?.c_title ?? row.cells?.c_index ?? '').trim(),
    value: String(row.cells?.[col.id] ?? ''),
    readOnly: !canEditCell(row, col.id),                        // admins edit; callers view (and a team-mate's chat is read-only)
    kind: col.id === 'c_feedback' ? 'chat' : 'text',           // Chat & Feedback → chat thread; JD → text editor
  });

  if (loading) return <div><span className="spinner" /> Loading…</div>;
  if (!grid) return <div className="card"><span className="muted">Could not load the board.</span></div>;

  const W = (c: Col) => c.width || DEFAULT_W;
  // Inject the Caller column's options from the live caller users (not persisted in the schema).
  // The Caller dropdown is a two-level tree: ungrouped callers first, then each team (selectable —
  // that hands the whole call to the team) with its own callers nested under it. Picking a team
  // writes the Team cell instead of Caller; see commitCell.
  const allCallers = people.filter((p) => (p.roles || []).includes('caller'));
  const callerOpts: Opt[] = (() => {
    const out: Opt[] = [];
    let i = 0;
    const hue = () => PALETTE[i++ % PALETTE.length];
    for (const c of allCallers.filter((c) => !String(c.team_id || '').trim())) {
      out.push({ label: c.label, color: hue() });                                   // ungrouped
    }
    for (const t of teams) {
      out.push({ label: t.name, color: hue(), kind: 'team' });                      // the team itself
      for (const c of allCallers.filter((c) => String(c.team_id || '').trim() === t.id)) {
        out.push({ label: c.label, color: hue(), kind: 'member', group: t.name });  // its callers
      }
    }
    return out;
  })();
  const teamNames = new Set(teams.map((t) => t.name));
  const teamOfCaller = (label: string) => {
    const p = allCallers.find((c) => c.label === label);
    return teams.find((t) => t.id === String(p?.team_id || '').trim())?.name || '';
  };
  const accountOpts: Opt[] = profiles.map((p, i) => ({ label: p.label, color: PALETTE[i % PALETTE.length] }));   // Account Profile options ← Profiles DB
  const teamOpts: Opt[] = teams.map((t, i) => ({ label: t.name, color: PALETTE[i % PALETTE.length] }));          // Team options ← teams table
  const cols = grid.columns.map((c) => {
    let cc = c;
    if (c.id === 'c_caller') cc = { ...cc, options: callerOpts };
    else if (c.id === 'c_account') cc = { ...cc, options: accountOpts };
    else if (c.id === 'c_team') cc = { ...cc, options: teamOpts };
    if (DISPLAY_NAME[c.id]) cc = { ...cc, name: DISPLAY_NAME[c.id] };   // display rename → propagates to header, button, modal title
    return cc;
  });
  const avatarByName: Record<string, string> = {};                 // Creater name → avatar image url
  people.forEach((p) => { if (p.avatar_url && p.label) avatarByName[p.label] = p.avatar_url; });
  const meName = me ? (me.full_name || me.username) : '';
  const isAdmin = !!me?.is_admin;   // only admins may edit columns / select-option lists
  const userTz = me?.timezone || undefined;   // display/enter Scheduled_at in the current user's zone
  const nowMs = Date.now();                   // refreshed by the 1-minute tick, so the highlight follows the clock
  const colById = Object.fromEntries(cols.map((c) => [c.id, c] as const));
  const visibleCols = cols.filter((c) => !STACK_HIDDEN.has(c.id));   // hide stacked-secondary columns
  const ncols = visibleCols.length;
  effColsRef.current = colById;   // give the clipboard codec the effective columns (incl. Caller options)

  // Filter dropdown options = the distinct values ACTUALLY present in the rows for that column.
  // The schema's select options can be empty (Call Type lost its options) or drift from the
  // injected/pasted values (Account stored without a region; Caller stored as a username while
  // the schema lists full names), which left those filters showing nothing or offering choices
  // that matched no row. Sourcing options from real values guarantees every option matches ≥1
  // row and every stored value is selectable. Built from grid.rows (not the filtered view) so the
  // option list stays stable as you filter.
  const filterOptionsFor = (cid: string): string[] => {
    const present = new Set<string>();
    for (const r of grid.rows) { const v = String(r.cells?.[cid] ?? ''); if (v) present.add(v); }
    return Array.from(present).sort((a, b) => a.localeCompare(b));
  };

  // ── filter bar: viewRows is what the grid shows AND operates on (keyboard/clipboard) ──
  const fltQ = (flt.q || '').trim().toLowerCase();
  const dFrom = flt.dateFrom || '';
  const dTo = flt.dateTo || '';
  const activeFilterCols = FILTER_COLS.filter((cid) => (colFlt[cid] || []).length > 0);
  const hasFilters = !!fltQ || activeFilterCols.length > 0 || !!dFrom || !!dTo;
  const matched = !hasFilters ? grid.rows : grid.rows.filter((row) => {
    for (const cid of activeFilterCols) if (!colFlt[cid].includes(String(row.cells?.[cid] ?? ''))) return false;
    if (dFrom || dTo) {                                  // Scheduled_at date range (YYYY-MM-DD compare)
      const sd = String(row.cells?.c_sched ?? '').slice(0, 10);
      if (dFrom && (!sd || sd < dFrom)) return false;
      if (dTo && (!sd || sd > dTo)) return false;
    }
    if (fltQ) {
      const hay = Object.values(row.cells || {}).map((v) => String(v ?? '')).join('  ').toLowerCase();
      if (!hay.includes(fltQ)) return false;
    }
    return true;
  });
  // Always sorted by Scheduled_at (earliest first). Changing a row's Scheduled_at re-renders → re-sorts,
  // so the row moves to its correct place. Unscheduled rows (incl. newly-added) stay at the bottom, visible.
  const schedMs = (r: Row) => { const s = String(r.cells?.c_sched ?? '').trim(); if (!s) return NaN; const t = new Date(s).getTime(); return isNaN(t) ? NaN : t; };
  const withMs = matched.map((r) => ({ r, ms: schedMs(r) }));
  const scheduled = withMs.filter((x) => !isNaN(x.ms)).sort((a, b) => a.ms - b.ms).map((x) => x.r);
  const unscheduled = withMs.filter((x) => isNaN(x.ms)).map((x) => x.r);
  // "Recent N" keeps the latest N schedules; unscheduled rows are always shown (the limit never hides them).
  const shownScheduled = limit > 0 && scheduled.length > limit ? scheduled.slice(scheduled.length - limit) : scheduled;
  const viewRows = [...shownScheduled, ...unscheduled];
  // Exactly ONE row is highlighted: the NEXT upcoming call — the soonest Scheduled_at still in the
  // future. `shownScheduled` is already sorted ascending, so the first one at/after now is it. Calls
  // that have passed, and every call after the next one, stay uncoloured.
  const nextUpId = shownScheduled.find((r) => { const ms = schedMs(r); return !isNaN(ms) && ms >= nowMs; })?.id ?? '';
  gridRef.current = { ...grid, rows: viewRows };   // keyboard/clipboard index into the visible (filtered) rows

  // Shared cell movement: collapse + move (sub-aware) or Shift-extend the focus. Used by keys AND editor nav.
  const moveActive = (dir: Dir, extend: boolean) => {
    const g = gridRef.current, s = selRef.current; if (!g || !s) return;
    const vc = g.columns.filter((c) => !STACK_HIDDEN.has(c.id));
    const nc = vc.length, nr = g.rows.length;
    if (extend) {
      let r2 = s.r2, c2 = s.c2;
      if (dir === 'down') r2 = Math.min(nr - 1, r2 + 1); else if (dir === 'up') r2 = Math.max(0, r2 - 1);
      else if (dir === 'right') c2 = Math.min(nc - 1, c2 + 1); else c2 = Math.max(0, c2 - 1);
      setSel({ r1: s.r1, c1: s.c1, r2, c2 });
      return;
    }
    const r0 = s.r1, c0 = s.c1, sub0 = aSubRef.current;
    const fieldsAt = (cc: number): SubField[] | null => MERGED[vc[cc]?.id] || null;
    const go = (r: number, c: number, sub: number) => { setSel({ r1: r, c1: c, r2: r, c2: c }); setASub(sub); };
    const f0 = fieldsAt(c0);
    const row0 = f0 ? (f0[sub0]?.row ?? 0) : 0;
    const bottomSub = (cc: number) => { const f = fieldsAt(cc); const i = f ? f.findIndex((x) => x.row === 1) : -1; return i >= 0 ? i : 0; };
    const rowSubs = (f: SubField[] | null, row: number) => (f ? f.map((x, i) => ({ x, i })).filter((o) => o.x.row === row).map((o) => o.i) : [0]);
    if (dir === 'down') { if (f0 && row0 === 0 && f0.some((x) => x.row === 1)) go(r0, c0, bottomSub(c0)); else if (r0 < nr - 1) go(r0 + 1, c0, 0); }
    else if (dir === 'up') { if (f0 && row0 === 1) go(r0, c0, 0); else if (r0 > 0) go(r0 - 1, c0, bottomSub(c0)); }
    else if (dir === 'right') { const rs = rowSubs(f0, row0), pos = rs.indexOf(sub0); if (f0 && pos >= 0 && pos < rs.length - 1) go(r0, c0, rs[pos + 1]); else if (c0 < nc - 1) go(r0, c0 + 1, 0); }
    else { const rs = rowSubs(f0, row0), pos = rs.indexOf(sub0); if (f0 && pos > 0) go(r0, c0, rs[pos - 1]); else if (c0 > 0) go(r0, c0 - 1, 0); }
  };
  moveActiveRef.current = moveActive;
  const fill = (dir: 'down' | 'right') => {   // Ctrl+D fills the top row down; Ctrl+R fills the left column right
    const g = gridRef.current, s = selRef.current; if (!g || !s) return;
    const vc = g.columns.filter((c) => !STACK_HIDDEN.has(c.id));
    const rmin = Math.min(s.r1, s.r2), rmax = Math.max(s.r1, s.r2), cmin = Math.min(s.c1, s.c2), cmax = Math.max(s.c1, s.c2);
    const btn = new Set(g.columns.filter((c) => c.type === 'button').map((c) => c.id));   // JD/Feedback are modal-edited — never a fill source/target
    const lg = logicalCols(vc).filter((x) => x.c >= cmin && x.c <= cmax && !btn.has(x.colId) && canEditRef.current(x.colId));  // skip read-only cols (caller)
    const at = (r: number, colId: string) => g.rows[r]?.cells?.[colId] ?? '';
    const changes: CellChange[] = [];
    if (dir === 'down') { for (const lc of lg) { const top = at(rmin, lc.colId); for (let r = rmin + 1; r <= rmax; r++) { const row = g.rows[r]; if (row) changes.push({ rowId: row.id, colId: lc.colId, value: top }); } } }
    else { for (let r = rmin; r <= rmax; r++) { const row = g.rows[r]; if (!row || !lg.length) continue; const left = at(r, lg[0].colId); for (let k = 1; k < lg.length; k++) changes.push({ rowId: row.id, colId: lg[k].colId, value: left }); } }
    recordCells(changes);
  };
  fillRef.current = fill;

  const norm = sel ? { rmin: Math.min(sel.r1, sel.r2), rmax: Math.max(sel.r1, sel.r2), cmin: Math.min(sel.c1, sel.c2), cmax: Math.max(sel.c1, sel.c2) } : null;
  /** Selection look for a NON-stacked cell: anchor = full border; range cells = fill + perimeter. */
  const cellSel = (r: number, c: number): { className: string; style: CSSProperties } => {
    if (!norm || !sel || r < norm.rmin || r > norm.rmax || c < norm.cmin || c > norm.cmax) return { className: '', style: {} };
    if (sel.r1 === r && sel.c1 === c) return { className: '', style: { boxShadow: `inset 0 0 0 2px ${SEL}` } };
    const p: string[] = [];
    if (r === norm.rmin) p.push(`inset 0 2px 0 0 ${SEL}`);
    if (r === norm.rmax) p.push(`inset 0 -2px 0 0 ${SEL}`);
    if (c === norm.cmin) p.push(`inset 2px 0 0 0 ${SEL}`);
    if (c === norm.cmax) p.push(`inset -2px 0 0 0 ${SEL}`);
    return { className: 'iv-td-fill', style: { boxShadow: p.join(', ') } };
  };
  // Copy-source outline (marching-ants): a thin blue perimeter around the copied rectangle.
  const cop = copied ? { rmin: Math.min(copied.r1, copied.r2), rmax: Math.max(copied.r1, copied.r2), cmin: Math.min(copied.c1, copied.c2), cmax: Math.max(copied.c1, copied.c2) } : null;
  const copiedEdge = (r: number, c: number): string[] => {
    if (!cop || r < cop.rmin || r > cop.rmax || c < cop.cmin || c > cop.cmax) return [];
    const CC = 'rgba(35,131,226,0.65)', p: string[] = [];
    if (r === cop.rmin) p.push(`inset 0 1px 0 0 ${CC}`);
    if (r === cop.rmax) p.push(`inset 0 -1px 0 0 ${CC}`);
    if (c === cop.cmin) p.push(`inset 1px 0 0 0 ${CC}`);
    if (c === cop.cmax) p.push(`inset -1px 0 0 0 ${CC}`);
    return p;
  };
  /** Per-sub-field selection state for a merged cell (sub-precise — see subsOf). */
  const stackState = (r: number, c: number, primaryId: string): SubState[] => {
    const fields = MERGED[primaryId] || [];
    if (!sel) return fields.map(() => 'none');
    const subs = subsOf(sel, aSub, r, c, fields.map((f) => f.row));
    return fields.map((_, i) => (!subs.includes(i) ? 'none' : (sel.r1 === r && sel.c1 === c && i === aSub ? 'anchor' : 'fill')));
  };

  return (
    <div className="iv-full">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Interviews</h1>
        <span className="muted" style={{ fontSize: '0.85rem' }}>{viewRows.length < grid.rows.length ? `${viewRows.length} of ${grid.rows.length}` : `${grid.rows.length} row${grid.rows.length === 1 ? '' : 's'}`}</span>
        <span style={{ flex: 1 }} />
        <NotifBell />
      </div>

      {/* Filter bar */}
      <div className="iv-filters">
        <input className="iv-flt-q" placeholder="Search…" value={flt.q || ''} onChange={(e) => setFlt((f) => ({ ...f, q: e.target.value }))} />
        {FILTER_COLS.filter((cid) => (!STAFF_ONLY_FILTERS.has(cid) || isAdmin || isTeamManager) && colById[cid]).map((cid) => {
          const col = colById[cid];
          return (
            <FilterDropdown key={cid} label={DISPLAY_NAME[cid] || col.name} options={filterOptionsFor(cid)}
              selected={colFlt[cid] || []} onChange={(next) => setColFlt((f) => ({ ...f, [cid]: next }))} />
          );
        })}
        <span className="muted iv-flt-lbl">From</span>
        <input type="date" className="iv-flt-date" title="Scheduled from" value={flt.dateFrom || ''} onChange={(e) => setFlt((f) => ({ ...f, dateFrom: e.target.value }))} />
        <span className="muted iv-flt-lbl">To</span>
        <input type="date" className="iv-flt-date" title="Scheduled to" value={flt.dateTo || ''} onChange={(e) => setFlt((f) => ({ ...f, dateTo: e.target.value }))} />
        {hasFilters && <button className="secondary iv-flt-clear" onClick={() => { setFlt({}); setColFlt({}); }}>Clear</button>}
        <span className="iv-flt-recent">
          <span className="muted">Recent</span>
          <input type="number" min={0} className="iv-flt-limit" title="How many recent schedules to show (0 = all)" placeholder="All"
            value={limit || ''} onChange={(e) => { const n = parseInt(e.target.value, 10); setLimit(Number.isFinite(n) && n > 0 ? n : 0); }} />
        </span>
      </div>

      <div className="iv-wrap">
        <table className="iv-grid" style={{ width: '100%' }}>
          <colgroup>
            <col style={{ width: 32 }} />
            {visibleCols.map((c) => <col key={c.id} style={{ width: W(c) }} />)}
          </colgroup>
          <thead>
            <tr>
              <th className="iv-gutter-hd" style={{ width: 32, textAlign: 'center' }} />
              {visibleCols.map((col) => {
                const mf = MERGED[col.id];
                const topExtra = mf ? mf.filter((f) => f.row === 0 && f.colId !== col.id).map((f) => ({ label: colById[f.colId]?.name || '', icon: f.icon, text: f.hdText })).filter((t) => t.label || t.icon) : undefined;
                const botSub = mf?.find((f) => f.row === 1);                 // bottom stacked field (its label may override the column name)
                const subLabel = botSub ? (botSub.label ?? colById[botSub.colId]?.name) : undefined;
                // select sub-fields whose option list admins can edit (Caller + Account Profile are DB-driven → excluded)
                const optionFields = (mf ? mf.map((f) => f.colId) : [col.id])
                  .map((id) => colById[id]).filter((cc) => cc && cc.type === 'select' && cc.id !== 'c_caller' && cc.id !== 'c_account')
                  .map((cc) => ({ colId: cc.id, name: cc.name, options: cc.options }));
                return (
                  <ColumnHead key={col.id} col={col}
                    subLabel={subLabel}
                    subExtra={col.id === 'c_sched' ? tzLabel(userTz) : undefined}   /* e.g. GMT+9 — which zone these times are in */
                    topExtra={topExtra}
                    admin={isAdmin} optionFields={optionFields}
                    onPatch={(p) => patchColumn(col.id, p)}
                    onFieldPatch={(id, p) => patchColumn(id, p)}
                    onDelete={() => deleteColumn(col.id)}
                    onResize={(w) => setColWidth(col.id, w)}
                    onResizeEnd={() => gridRef.current && saveSchema(gridRef.current.columns)} />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {hasFilters && viewRows.length === 0 && (
              <tr><td className="iv-gutter" /><td colSpan={ncols} className="muted" style={{ padding: '14px 12px', fontSize: '0.85rem' }}>No interviews match the filters.</td></tr>
            )}
            {viewRows.map((row, ri) => (
              <tr key={row.id} data-rid={row.id} className={'iv-row' + (row.id === flashRow ? ' iv-row--flash' : '') + (row.id === nextUpId ? ' iv-row--next' : '')}>
                <td className="iv-gutter" title={`Row ${ri + 1}`}
                    onMouseDown={(e) => {
                      if (e.button !== 0 || (e.target as HTMLElement).closest('.iv-del')) return;   // ignore the delete button
                      anchor.current = { r: ri, c: 0 }; dragging.current = false;
                      setSel({ r1: ri, c1: 0, r2: ri, c2: ncols - 1 }); setASub(0); setEditing(null);
                    }}>
                  <span className={'iv-num' + ((ri + 1) % 5 === 0 ? ' iv-num--mark' : '')}>{ri + 1}</span>
                  {isAdmin && <button className="ghost iv-del" title="Delete row" onClick={() => setConfirmDel(row.id)}>✕</button>}
                </td>
                {visibleCols.map((col, c) => {
                  const isAnchorCell = sel?.r1 === ri && sel?.c1 === c;
                  if (isMerged(col.id)) {
                    const fields = MERGED[col.id].map((f, i) => ({ col: colById[f.colId], sub: i, row: f.row, width: f.width })).filter((f) => f.col);
                    const ce = copiedEdge(ri, c);
                    return (
                      <td key={col.id} ref={isAnchorCell ? anchorTdRef : undefined} style={{ padding: 0, ...(ce.length ? { boxShadow: ce.join(', ') } : {}) }} onMouseEnter={() => extendTo(ri, c)}>
                        <StackedCell fields={fields} row={row} meName={meName} avatarByName={avatarByName} tz={userTz}
                          subState={stackState(ri, c, col.id)}
                          editSub={editing && editing.r === ri && editing.c === c ? editing.s : null}
                          editSeed={editing && editing.r === ri && editing.c === c ? editing.seed : undefined}
                          onSelect={(sub, openType, shift) => selectCellSub(ri, c, sub, openType, shift)}
                          onEdit={(sub) => editCell(ri, c, sub)}
                          onDone={(dir) => { setEditing(null); if (dir) moveActive(dir, false); }}
                          onOpenModal={(mcol) => openModal(row, mcol)}
                          commit={(cid, v) => commitCell(row.id, cid, v)} />
                      </td>
                    );
                  }
                  const ss = cellSel(ri, c);
                  const ce = copiedEdge(ri, c);
                  const tdStyle: CSSProperties = { padding: 0, ...ss.style };
                  if (ce.length) tdStyle.boxShadow = [ss.style.boxShadow, ...ce].filter(Boolean).join(', ');
                  const isEditing = !!editing && editing.r === ri && editing.c === c && editing.s === 0;
                  const cval = row.cells?.[col.id];
                  const autoMe = AUTO_ME_COLS.has(col.id) && (cval === '' || cval == null) && !!meName && rowIndexSet(row);
                  // Hovering the Index reveals this row's Created_at (now a hidden, hover-only field).
                  const created = col.id === 'c_index' ? String(row.cells?.c_created ?? '').trim() : '';
                  if (created) tdStyle.position = 'relative';
                  return (
                    <td key={col.id} ref={isAnchorCell ? anchorTdRef : undefined} className={ss.className} style={tdStyle}
                        onMouseDown={(e) => selectCell(e, ri, c, 0, false)}
                        onMouseEnter={() => extendTo(ri, c)}
                        onClick={autoMe ? () => commitCell(row.id, col.id, meName) : undefined}
                        onDoubleClick={() => editCell(ri, c, 0)}>
                      <CellEditor col={col} value={cval} editing={isEditing} seed={isEditing ? editing?.seed : undefined} tz={userTz}
                        avatar={col.type === 'person' ? avatarByName[String(cval ?? '')] : undefined}
                        onCommit={(v) => commitCell(row.id, col.id, v)} onDone={(dir) => { setEditing(null); if (dir) moveActive(dir, false); }}
                        onOpen={col.type === 'button' ? () => openModal(row, col) : () => editCell(ri, c, 0)} />
                      {created ? <span className="iv-created-tip">Created {tsInTz(created, me?.timezone)}</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
            {isAdmin && !hasFilters && (
              <tr className="iv-addrow" onClick={addRow} title="Add a row">
                <td className="iv-gutter" style={{ cursor: 'pointer', color: '#9B9B9B' }}>+</td>
                <td colSpan={ncols} style={{ cursor: 'pointer' }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (modal.kind === 'chat'
        ? <ChatModal title={modal.title} subtitle={modal.subtitle} value={modal.value} me={me} readOnly={modal.readOnly} rowId={modal.rowId}
            onSync={(v) => setGrid((g) => (g ? { ...g, rows: g.rows.map((r) => (r.id === modal.rowId ? { ...r, cells: { ...r.cells, [modal.colId]: v } } : r)) } : g))}
            onClose={() => setModal(null)} />
        : <CellModal title={modal.title} subtitle={modal.subtitle} value={modal.value} readOnly={modal.readOnly}
            onSave={(v) => commitCell(modal.rowId, modal.colId, v)}
            onClose={() => setModal(null)} />
      )}
      {confirmDel && (
        <ConfirmModal title="Delete row?" message="This row and all of its data will be permanently removed."
          confirmLabel="Delete" danger
          onConfirm={() => { const id = confirmDel; setConfirmDel(null); deleteRow(id); }}
          onCancel={() => setConfirmDel(null)} />
      )}
    </div>
  );
}
