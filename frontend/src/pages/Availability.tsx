/* Availability — when this person can take calls.
 *
 * Its own page, not a card on the Account page: it is the roster, not the profile, and it is the only
 * thing a caller really has to keep up to date. The board will not show anybody at all until BOTH the
 * hours and the time zone are set, which is why the zone lives here rather than under Account — the
 * hours are meaningless without it.
 */
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { useAuth, loadCurrentUser } from '../lib/auth';
import { BROWSER_TZ, TimezonePicker, tzDisplay, gmtLabel } from '../lib/TimezonePicker';

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
type Slot = { on: boolean; start: string; end: string };
type Availability = Record<DayKey, Slot>;

/* A meeting you have on your working days — a standup, a team sync, a 1:1. It sits INSIDE your hours:
   you are at work, you just cannot take a call then. So it punches a hole in your availability rather
   than changing your hours, and the board will not offer that time. `days` empty = every day you work.
   You can have several — most people do. */
type Meeting = { on: boolean; title: string; start: string; end: string; days: DayKey[] };
const NEW_MEETING = (): Meeting => ({ on: true, title: '', start: '10:00', end: '10:30', days: [] });
const MAX_MEETINGS = 8;

const DAYS: { key: DayKey; label: string; short: string }[] = [
  { key: 'mon', label: 'Monday', short: 'Mon' }, { key: 'tue', label: 'Tuesday', short: 'Tue' },
  { key: 'wed', label: 'Wednesday', short: 'Wed' }, { key: 'thu', label: 'Thursday', short: 'Thu' },
  { key: 'fri', label: 'Friday', short: 'Fri' }, { key: 'sat', label: 'Saturday', short: 'Sat' },
];
const DEFAULT_AVAIL: Availability = DAYS.reduce((a, d) => {
  a[d.key] = { on: d.key !== 'sat', start: '09:00', end: '18:00' };   // Mon–Fri on, Saturday off
  return a;
}, {} as Availability);

const todayISO = () => new Date().toISOString().slice(0, 10);
const prettyDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
};
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };

export default function AvailabilityPage() {
  const { user } = useAuth();
  const toast = useToast();

  const [tz, setTz] = useState('');
  const [avail, setAvail] = useState<Availability>(DEFAULT_AVAIL);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [daysOff, setDaysOff] = useState<string[]>([]);
  const [newDayOff, setNewDayOff] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    setTz(user.timezone || '');
    setAvail({ ...DEFAULT_AVAIL, ...((user.availability || {}) as Availability) });
    setMeetings(((user.daily_meetings || []) as Meeting[]).map((m) => ({ ...NEW_MEETING(), ...m })));
    setDaysOff([...(user.days_off || [])].sort());
  }, [user]);

  const setDay = (d: DayKey, patch: Partial<Slot>) => setAvail((a) => ({ ...a, [d]: { ...a[d], ...patch } }));
  const setMeeting = (i: number, patch: Partial<Meeting>) =>
    setMeetings((ms) => ms.map((m, k) => (k === i ? { ...m, ...patch } : m)));
  const addMeeting = () => setMeetings((ms) => (ms.length >= MAX_MEETINGS ? ms : [...ms, NEW_MEETING()]));
  const dropMeeting = (i: number) => setMeetings((ms) => ms.filter((_, k) => k !== i));

  const addDayOff = () => {
    const d = newDayOff.trim();
    if (!d || daysOff.includes(d)) { setNewDayOff(''); return; }
    setDaysOff((xs) => [...xs, d].sort());
    setNewDayOff('');
  };

  /* Two meetings that overlap are almost always a mistake, and the calendar would just draw them on top
     of one another. Flag it rather than silently accepting it. */
  const clashes = new Set<number>();
  meetings.forEach((a, i) => meetings.forEach((b, j) => {
    if (i >= j || !a.on || !b.on) return;
    const sameDay = !a.days.length || !b.days.length || a.days.some((d) => b.days.includes(d));
    if (sameDay && toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end)) { clashes.add(i); clashes.add(j); }
  }));

  const save = async () => {
    const badDay = DAYS.find((d) => avail[d.key].on && avail[d.key].end <= avail[d.key].start);
    if (badDay) { toast(`${badDay.label}: the end time must be after the start.`, 'error'); return; }
    const badMeeting = meetings.findIndex((m) => m.on && m.end <= m.start);
    if (badMeeting >= 0) { toast(`Meeting ${badMeeting + 1}: the end time must be after the start.`, 'error'); return; }
    if (clashes.size) { toast('Two meetings overlap — fix them before saving.', 'error'); return; }

    setSaving(true);
    try {
      await api.patch('/api/auth/me', {
        timezone: tz,
        availability: avail,
        // blank titles get a sensible default server-side; drop entries the user emptied out entirely
        daily_meetings: meetings.map((m) => ({ ...m, title: m.title.trim() })),
        days_off: daysOff,
      });
      await loadCurrentUser();
      toast('Availability saved', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to save availability', 'error');
    } finally { setSaving(false); }
  };

  const workingDays = DAYS.filter((d) => avail[d.key].on);

  return (
    <div>
      <h1>Availability</h1>
      <p className="muted" style={{ marginTop: -8, marginBottom: 18, fontSize: '0.88rem' }}>
        When you can take calls. The board uses this to shade your free time and to warn whoever books a
        call outside it — it shows nothing at all for you until both your hours <em>and</em> your time
        zone are set.
      </p>

      {/* Time zone — first, because every time below is on THIS clock */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Time zone</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: '0.84rem' }}>
          Every time on this page is on <strong>your own clock</strong>. Your colleagues see them
          converted to theirs, so this has to be right.
        </p>
        <div style={{ maxWidth: 460 }}>
          <TimezonePicker value={tz} onChange={setTz} />
          {BROWSER_TZ && tz !== BROWSER_TZ && (
            <span className="link" style={{ fontSize: '0.8rem', display: 'inline-block', marginTop: 6, cursor: 'pointer' }}
              onClick={() => setTz(BROWSER_TZ)}>Use my detected zone ({tzDisplay(BROWSER_TZ)})</span>
          )}
          {!tz && (
            <p style={{ color: '#f59e0b', fontSize: '0.8rem', marginTop: 8 }}>
              ⚠ Without a time zone your hours mean nothing, and you will not appear on the calendar.
            </p>
          )}
        </div>
      </div>

      {/* Weekly hours */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Working hours</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: '0.84rem' }}>
          Monday to Saturday{tz ? <> — on <strong>{gmtLabel(tz)}</strong>, your clock</> : null}. Untick a
          day you don't work.
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          {DAYS.map((d) => {
            const s = avail[d.key];
            const invalid = s.on && s.end <= s.start;
            return (
              <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 130, cursor: 'pointer', textTransform: 'none', margin: 0 }}>
                  <input type="checkbox" checked={s.on} onChange={(e) => setDay(d.key, { on: e.target.checked })} />
                  <span style={{ fontWeight: s.on ? 600 : 400, opacity: s.on ? 1 : 0.55 }}>{d.label}</span>
                </label>
                {s.on ? (
                  <>
                    <input type="time" value={s.start} onChange={(e) => setDay(d.key, { start: e.target.value })} style={{ width: 120 }} />
                    <span className="muted">to</span>
                    <input type="time" value={s.end} onChange={(e) => setDay(d.key, { end: e.target.value })} style={{ width: 120 }} />
                    {invalid && <span style={{ color: '#ef4444', fontSize: '0.78rem' }}>end must be after start</span>}
                  </>
                ) : (
                  <span className="muted" style={{ fontSize: '0.82rem' }}>Not working</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Daily meetings — as many as you actually have */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Daily meetings</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: '0.84rem' }}>
          Meetings you have on your working days — a standup, a team sync, a 1:1. Each one sits{' '}
          <em>inside</em> your hours above: you're at work, you just can't take a call then. The board
          won't offer these times and will flag any call booked over them. Add as many as you have.
        </p>

        {!meetings.length && (
          <p className="muted" style={{ fontSize: '0.84rem', margin: '10px 0' }}>No recurring meetings.</p>
        )}

        <div style={{ display: 'grid', gap: 10 }}>
          {meetings.map((m, i) => {
            const bad = m.on && m.end <= m.start;
            const clash = clashes.has(i);
            return (
              <div key={i} className="av-meeting" style={{
                border: `1px solid ${bad || clash ? '#ef444455' : '#243355'}`,
                borderRadius: 10, padding: '10px 12px',
                background: m.on ? '#141e35' : '#0f1629', opacity: m.on ? 1 : 0.6,
              }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', textTransform: 'none', margin: 0 }}
                    title={m.on ? 'Switch this meeting off without deleting it' : 'Switch it back on'}>
                    <input type="checkbox" checked={m.on} onChange={(e) => setMeeting(i, { on: e.target.checked })} />
                  </label>
                  <input type="text" placeholder="Daily standup" value={m.title} maxLength={60}
                    onChange={(e) => setMeeting(i, { title: e.target.value })} style={{ width: 190 }} />
                  <input type="time" value={m.start} onChange={(e) => setMeeting(i, { start: e.target.value })} style={{ width: 118 }} />
                  <span className="muted">to</span>
                  <input type="time" value={m.end} onChange={(e) => setMeeting(i, { end: e.target.value })} style={{ width: 118 }} />
                  <span style={{ flex: 1 }} />
                  <button className="ghost" title="Remove this meeting" style={{ padding: '4px 10px' }}
                    onClick={() => dropMeeting(i)}>✕</button>
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                  <span className="muted" style={{ fontSize: '0.78rem' }}>On:</span>
                  {DAYS.map((d) => {
                    const picked = m.days.includes(d.key);
                    const works = avail[d.key].on;
                    return (
                      <label key={d.key} title={works ? '' : `You don't work ${d.label}`}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0, textTransform: 'none',
                                 cursor: works ? 'pointer' : 'not-allowed', opacity: works ? 1 : 0.4 }}>
                        <input type="checkbox" checked={picked} disabled={!works}
                          onChange={(e) => setMeeting(i, {
                            days: e.target.checked ? [...m.days, d.key] : m.days.filter((x) => x !== d.key),
                          })} />
                        <span style={{ fontSize: '0.8rem' }}>{d.short}</span>
                      </label>
                    );
                  })}
                  <span className="muted" style={{ fontSize: '0.76rem', marginLeft: 4 }}>
                    {m.days.length === 0
                      ? `every day you work (${workingDays.map((d) => d.short).join(', ') || 'none'})`
                      : ''}
                  </span>
                </div>

                {bad && <p style={{ color: '#ef4444', fontSize: '0.78rem', marginTop: 6 }}>End must be after start.</p>}
                {clash && !bad && <p style={{ color: '#ef4444', fontSize: '0.78rem', marginTop: 6 }}>
                  This overlaps another meeting on the same day.
                </p>}
              </div>
            );
          })}
        </div>

        <button className="secondary" style={{ marginTop: 12 }}
          onClick={addMeeting} disabled={meetings.length >= MAX_MEETINGS}>
          + Add a meeting
        </button>
        {meetings.length >= MAX_MEETINGS && (
          <span className="muted" style={{ fontSize: '0.78rem', marginLeft: 10 }}>Maximum {MAX_MEETINGS}.</span>
        )}
      </div>

      {/* Days off */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Days I can't work</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: '0.84rem' }}>
          One-off dates that override the week above — holidays, appointments, anything.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" min={todayISO()} value={newDayOff}
            onChange={(e) => setNewDayOff(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDayOff(); } }}
            style={{ width: 180 }} />
          <button className="secondary" onClick={addDayOff} disabled={!newDayOff}>+ Add day off</button>
        </div>
        {daysOff.length === 0 ? (
          <span className="muted" style={{ fontSize: '0.82rem', display: 'inline-block', marginTop: 8 }}>No days off added.</span>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {daysOff.map((d) => (
              <span key={d} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 10px',
                borderRadius: 999, background: '#3b82f628', border: '1px solid #3b82f655', fontSize: '0.82rem',
              }}>
                {prettyDate(d)}
                <button className="ghost" title="Remove" style={{ padding: '0 4px', lineHeight: 1 }}
                  onClick={() => setDaysOff((xs) => xs.filter((x) => x !== d))}>✕</button>
              </span>
            ))}
          </div>
        )}
      </div>

      <button onClick={save} disabled={saving}>
        {saving ? <span className="spinner" /> : 'Save availability'}
      </button>
    </div>
  );
}
