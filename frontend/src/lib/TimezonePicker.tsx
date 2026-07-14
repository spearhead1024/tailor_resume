/* Time-zone picker, shared by the Account page and the Availability page.
 *
 * It lives here rather than inside a page because a caller's working hours are meaningless without the
 * zone they are written in — the two belong together, and the calendar needs BOTH before it will show
 * anybody at all.
 */
import { useEffect, useRef, useState } from 'react';

const BROWSER_TZ: string = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();

// Country / alias keywords per zone so the picker is searchable by country too (city/capital comes from the zone id).
const TZ_COUNTRY: Record<string, string> = {
  'America/New_York': 'united states usa america', 'America/Chicago': 'united states usa america', 'America/Denver': 'united states usa america', 'America/Los_Angeles': 'united states usa america', 'America/Phoenix': 'united states usa arizona', 'America/Anchorage': 'united states usa alaska', 'Pacific/Honolulu': 'united states usa hawaii',
  'America/Toronto': 'canada', 'America/Vancouver': 'canada', 'America/Edmonton': 'canada', 'America/Winnipeg': 'canada', 'America/Halifax': 'canada',
  'America/Mexico_City': 'mexico', 'America/Sao_Paulo': 'brazil', 'America/Argentina/Buenos_Aires': 'argentina', 'America/Bogota': 'colombia', 'America/Lima': 'peru', 'America/Santiago': 'chile',
  'Europe/London': 'united kingdom uk england britain', 'Europe/Dublin': 'ireland', 'Europe/Paris': 'france', 'Europe/Berlin': 'germany', 'Europe/Madrid': 'spain', 'Europe/Rome': 'italy', 'Europe/Amsterdam': 'netherlands holland', 'Europe/Brussels': 'belgium', 'Europe/Zurich': 'switzerland', 'Europe/Vienna': 'austria', 'Europe/Lisbon': 'portugal', 'Europe/Stockholm': 'sweden', 'Europe/Oslo': 'norway', 'Europe/Copenhagen': 'denmark', 'Europe/Helsinki': 'finland', 'Europe/Warsaw': 'poland', 'Europe/Prague': 'czech czechia', 'Europe/Budapest': 'hungary', 'Europe/Bucharest': 'romania', 'Europe/Athens': 'greece', 'Europe/Kyiv': 'ukraine', 'Europe/Moscow': 'russia', 'Europe/Istanbul': 'turkey turkiye',
  'Africa/Cairo': 'egypt', 'Africa/Lagos': 'nigeria', 'Africa/Johannesburg': 'south africa', 'Africa/Nairobi': 'kenya', 'Africa/Casablanca': 'morocco', 'Africa/Accra': 'ghana', 'Africa/Algiers': 'algeria',
  'Asia/Dubai': 'united arab emirates uae', 'Asia/Riyadh': 'saudi arabia', 'Asia/Qatar': 'qatar', 'Asia/Tehran': 'iran', 'Asia/Baghdad': 'iraq', 'Asia/Jerusalem': 'israel', 'Asia/Karachi': 'pakistan', 'Asia/Kolkata': 'india', 'Asia/Dhaka': 'bangladesh', 'Asia/Kathmandu': 'nepal', 'Asia/Colombo': 'sri lanka', 'Asia/Bangkok': 'thailand', 'Asia/Ho_Chi_Minh': 'vietnam', 'Asia/Jakarta': 'indonesia', 'Asia/Kuala_Lumpur': 'malaysia', 'Asia/Singapore': 'singapore', 'Asia/Manila': 'philippines', 'Asia/Hong_Kong': 'hong kong', 'Asia/Shanghai': 'china', 'Asia/Taipei': 'taiwan', 'Asia/Seoul': 'south korea', 'Asia/Tokyo': 'japan', 'Asia/Yangon': 'myanmar',
  'Australia/Sydney': 'australia', 'Australia/Melbourne': 'australia', 'Australia/Brisbane': 'australia', 'Australia/Perth': 'australia', 'Australia/Adelaide': 'australia',
  'Pacific/Auckland': 'new zealand', 'Pacific/Fiji': 'fiji', 'UTC': 'utc gmt universal',
};

/** GMT offset label for a zone, e.g. "GMT+9", "GMT+5:30", "GMT+0". */
function gmtLabel(tz: string): string {
  try {
    const v = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value || '';
    const m = v.match(/GMT([+-]\d{1,2}(?::\d{2})?)?/);
    if (m) return 'GMT' + (m[1] ?? '+0');
  } catch { /* */ }
  return 'GMT?';
}
function gmtMin(label: string): number {
  const m = label.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return m ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0)) : 0;
}
type TzOpt = { tz: string; display: string; search: string; min: number };
// Every IANA zone, labelled "(GMT±X) Region/City", searchable by city + country, sorted by offset.
const TZ_ALL: TzOpt[] = (() => {
  let list: string[] = [];
  try { const a = (Intl as any).supportedValuesOf?.('timeZone'); if (Array.isArray(a) && a.length) list = a; } catch { /* */ }
  if (!list.length) list = Object.keys(TZ_COUNTRY);
  return list.map((tz) => {
    const g = gmtLabel(tz), pretty = tz.replace(/_/g, ' ');
    return { tz, display: `(${g}) ${pretty}`, search: `${pretty} ${g} ${TZ_COUNTRY[tz] || ''}`.toLowerCase(), min: gmtMin(g) };
  }).sort((a, b) => a.min - b.min || a.tz.localeCompare(b.tz));
})();
const tzDisplay = (tz: string) => TZ_ALL.find((o) => o.tz === tz)?.display || tz;

/** Searchable time-zone picker: type a country or city, options show the GMT offset. */
function TimezonePicker({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEffect(() => { if (open) { setQ(''); setHl(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = terms.length ? TZ_ALL.filter((o) => terms.every((t) => o.search.includes(t))) : TZ_ALL;
  const pick = (tz: string) => { onChange(tz); setOpen(false); };
  return (
    <div ref={ref} className="tz-picker">
      <button type="button" className="tz-btn" onClick={() => setOpen((o) => !o)}>
        <span className={value ? '' : 'muted'} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value ? tzDisplay(value) : '— Select time zone —'}</span>
        <span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div className="card tz-menu">
          <input ref={inputRef} className="tz-search" value={q} placeholder="Search country or city…"
            onChange={(e) => { setQ(e.target.value); setHl(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(filtered.length - 1, h + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); if (filtered[hl]) pick(filtered[hl].tz); }
              else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
            }} />
          <div className="tz-list">
            {filtered.length === 0 && <div className="muted" style={{ padding: 8, fontSize: '0.82rem' }}>No matches</div>}
            {filtered.map((o, i) => (
              <div key={o.tz} className={'tz-opt' + (i === hl ? ' tz-opt--hl' : '') + (o.tz === value ? ' tz-opt--sel' : '')}
                onMouseEnter={() => setHl(i)} onClick={() => pick(o.tz)}>{o.display}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function initials(name: string): string {
  const n = (name || '').trim();
  if (!n) return '?';
  return n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

export { BROWSER_TZ, TZ_ALL, tzDisplay, gmtLabel, TimezonePicker };
