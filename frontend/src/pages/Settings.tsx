import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { useAuth, loadCurrentUser, hasRole } from '../lib/auth';
import { leadLabel, MinutesListEditor, cleanMinutesList } from '../lib/minutesList';

type SubTab = 'general' | 'notifications' | 'prompt' | 'domains' | 'titles' | 'companies';

/* Interview reminder settings. Every time here is on the CALLER's clock (their profile timezone).
   The creater/CBM heads-ups are enabled/disabled here (a global kill-switch for the whole feature,
   admin-set, saved via /api/settings), but WHEN each fires is each person's OWN choice — the chip
   editors further down save the SIGNED-IN admin's own creator_lead_minutes_list/cbm_lead_minutes_list
   via /api/auth/me, not the shared settings blob. A single shared time here used to mean one admin's
   preference silently became every admin's and every CBM's — not what anyone wants when several
   people hold those roles. NOTE: this page is admin-only (RoleGate), so a call-board manager who is
   NOT also an admin cannot reach this editor at all and is stuck on the system default (90 min) — the
   info card below says so. */
type Notif = {
  lead_enabled: boolean; lead_minutes: number;
  day_before_enabled: boolean; day_before_hour: number;
  day_of_enabled: boolean; day_of_hour: number;
  creator_enabled: boolean;
  cbm_enabled: boolean;
};
const NOTIF_DEFAULTS: Notif = {
  lead_enabled: true, lead_minutes: 60,
  day_before_enabled: true, day_before_hour: 19,   // 7pm
  day_of_enabled: true, day_of_hour: 8,            // 8am
  creator_enabled: true,   // ping whoever booked the call, at THEIR OWN configured times
  cbm_enabled: true,       // ping every call-board manager, at EACH of THEIR OWN configured times
};
const hourName = (h: number) => `${(h % 12) || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

/** The explanatory text beside a control. Given its own flex basis so it wraps as a paragraph
    instead of being squeezed into a one-word-per-line column. */
function Hint({ children }: { children: React.ReactNode }) {
  return <span className="muted" style={{ flex: '1 1 240px', minWidth: 150, fontSize: '0.82rem', lineHeight: 1.5 }}>{children}</span>;
}

/** One reminder, as a card: who gets it, when it fires, and what it will actually say. `preview` is
    one string, or several — a role with multiple configured lead times (creater/CBM) shows one
    preview line per time, so it's clear each fires as its own separate notification. */
function ReminderCard({ on, onToggle, icon, title, when, to, preview, note }: {
  on: boolean; onToggle: (v: boolean) => void; icon: string; title: string;
  when: React.ReactNode; to: 'Caller' | 'Creator' | 'Board mgr'; preview: string | string[]; note?: React.ReactNode;
}) {
  const previews = Array.isArray(preview) ? preview : [preview];
  const toColour = to === 'Caller' ? '#3b82f6' : to === 'Creator' ? '#a855f7' : '#14b8a6';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '13px 14px', borderRadius: 10,
      border: `1px solid ${on ? 'rgba(255,255,255,0.10)' : 'transparent'}`,
      background: on ? 'rgba(255,255,255,0.03)' : 'transparent',
      opacity: on ? 1 : 0.5, transition: 'opacity .12s ease, background .12s ease',
    }}>
      {/* the flex-basis values are explicit: the checkbox and icon must never grow, and the body
          must be free to shrink (minWidth:0), or the text wraps one word per line */}
      <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)}
        style={{ flex: '0 0 auto', width: 16, height: 16, marginTop: 3 }} />
      <span style={{ flex: '0 0 auto', fontSize: '1.05rem', lineHeight: 1.35 }}>{icon}</span>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong>{title}</strong>
          <span style={{
            fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600,
            padding: '1px 7px', borderRadius: 999, color: toColour, whiteSpace: 'nowrap',
            background: `${toColour}22`, border: `1px solid ${toColour}55`,
          }}>{to}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 7 }}>{when}</div>
        {note && <div className="muted" style={{ fontSize: '0.78rem', marginTop: 6 }}>{note}</div>}
        <div style={{ marginTop: 8 }}>
          {previews.map((p, i) => (
            <div key={i} className="muted" style={{ fontSize: '0.78rem', fontStyle: 'italic' }}>🔔 “{p}”</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function toLines(arr: any): string {
  return Array.isArray(arr) ? arr.join('\n') : '';
}
function parseList(text: string): string[] {
  return text.split(/[\n,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export default function Settings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<any>('/api/settings'),
  });

  const [subTab, setSubTab] = useState<SubTab>('general');

  const [deadline, setDeadline] = useState('12');
  const [deadlineDirty, setDeadlineDirty] = useState(false);

  const [template, setTemplate] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);

  const [domainsText, setDomainsText] = useState('');
  const [domainsDirty, setDomainsDirty] = useState(false);

  const [titlesText, setTitlesText] = useState('');
  const [titlesDirty, setTitlesDirty] = useState(false);

  const [companiesText, setCompaniesText] = useState('');
  const [companiesDirty, setCompaniesDirty] = useState(false);

  const [notif, setNotif] = useState<Notif>(NOTIF_DEFAULTS);
  const [notifDirty, setNotifDirty] = useState(false);

  // The SIGNED-IN admin's own creator/CBM reminder times — per-person data (core/storage.py on the
  // user record), saved via /api/auth/me, NOT part of the app-wide settings blob above. Separate
  // dirty/save state on purpose: an unrelated save path from the rest of this tab.
  const [creatorMins, setCreatorMins] = useState<number[]>([]);
  const [cbmMins, setCbmMins] = useState<number[]>([]);
  const [remindersDirty, setRemindersDirty] = useState(false);
  const [remindersSaving, setRemindersSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setDeadline(String(data.job_deadline_hours ?? 12)); setDeadlineDirty(false);
      setTemplate(String(data.prompt_template || '')); setPromptDirty(false);
      setDomainsText(toLines(data.blacklist_domains)); setDomainsDirty(false);
      setTitlesText(toLines(data.blacklist_titles)); setTitlesDirty(false);
      setCompaniesText(toLines(data.blacklist_companies)); setCompaniesDirty(false);
      setNotif({ ...NOTIF_DEFAULTS, ...(data.notifications || {}) }); setNotifDirty(false);
    }
  }, [data]);

  useEffect(() => {
    if (!user) return;
    setCreatorMins(user.creator_lead_minutes_list || []);
    setCbmMins(user.cbm_lead_minutes_list || []);
    setRemindersDirty(false);
  }, [user]);

  // An empty list is a legitimate, intentional choice — "use the system default" — so the fallback
  // passed to cleanMinutesList is [] (not e.g. [90]): clearing every chip and saving must actually
  // persist as empty, not silently snap back to a non-empty default.
  const saveReminders = async () => {
    setRemindersSaving(true);
    try {
      await api.patch('/api/auth/me', {
        creator_lead_minutes_list: cleanMinutesList(creatorMins, []),
        cbm_lead_minutes_list: cleanMinutesList(cbmMins, []),
      });
      await loadCurrentUser();
      setRemindersDirty(false);
      toast('Your reminder times saved', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to save reminder times', 'error');
    } finally { setRemindersSaving(false); }
  };

  const saveMutation = useMutation({
    mutationFn: ({ payload }: { payload: any; what: string }) => api.put('/api/settings', { payload }),
    onSuccess: (_res: any, vars: { payload: any; what: string }) => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      const what = vars.what || 'Settings';
      if (what === 'Deadline') setDeadlineDirty(false);
      if (what === 'Prompt') setPromptDirty(false);
      if (what === 'Domains') setDomainsDirty(false);
      if (what === 'Titles') setTitlesDirty(false);
      if (what === 'Companies') setCompaniesDirty(false);
      if (what === 'Notifications') setNotifDirty(false);
      toast(`${what} saved`, 'success');
    },
    onError: (e: any) => toast(e?.response?.data?.detail || 'Failed to save', 'error'),
  });

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  const save = (patch: any, what: string) =>
    saveMutation.mutate({ payload: { ...(data || {}), ...patch }, what });

  const tabBtn = (key: SubTab, label: string) => (
    <button key={key} onClick={() => setSubTab(key)}
      className={subTab === key ? '' : 'secondary'}
      style={{ borderRadius: 999, padding: '4px 14px', fontSize: '0.85rem' }}>
      {label}
    </button>
  );

  const listEditor = (
    opts: {
      text: string; setText: (s: string) => void; dirty: boolean; setDirty: (b: boolean) => void;
      label: string; placeholder: string; help: React.ReactNode; saveKey: string; what: string; field: string;
    },
  ) => (
    <>
      <p className="muted">{opts.help}</p>
      <div className="card">
        <label style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)' }}>
          {opts.label}
        </label>
        <textarea rows={16} value={opts.text} placeholder={opts.placeholder}
          onChange={(e) => { opts.setText(e.target.value); opts.setDirty(true); }}
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem', marginTop: 6 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <button onClick={() => save({ [opts.field]: parseList(opts.text) }, opts.what)} disabled={!opts.dirty || saveMutation.isPending}>
            {saveMutation.isPending ? <span className="spinner" /> : 'Save'}
          </button>
          <button className="secondary" disabled={!opts.dirty || saveMutation.isPending}
            onClick={() => { opts.setText(toLines((data || {})[opts.field])); opts.setDirty(false); }}>
            Discard changes
          </button>
          {opts.dirty && <span className="muted" style={{ fontSize: '0.82rem' }}>Unsaved changes</span>}
          <span style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: '0.82rem' }}>
            {(Array.isArray((data || {})[opts.field]) ? (data as any)[opts.field].length : 0)} saved
          </span>
        </div>
      </div>
    </>
  );

  return (
    <div>
      <h1>Settings</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: '1rem', flexWrap: 'wrap' }}>
        {tabBtn('general', 'General')}
        {tabBtn('notifications', 'Notifications')}
        {tabBtn('prompt', 'Prompt template')}
        {tabBtn('domains', 'Blacklist domains')}
        {tabBtn('titles', 'Blacklist titles')}
        {tabBtn('companies', 'Blacklist companies')}
      </div>

      {subTab === 'general' && (
        <>
          <p className="muted">
            Job deadline — how long a job stays workable. A job appears in the <strong>Resumes</strong> tab for this
            many hours after it's added; a generated resume stays in the <strong>Apply</strong> tab for this many hours
            after it's <em>generated</em> (so freshly-made resumes don't vanish if their job just aged out).
          </p>
          <div className="card">
            <label style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)' }}>
              Job deadline (hours)
            </label>
            <input type="number" min={1} max={168} value={deadline}
              onChange={(e) => { setDeadline(e.target.value); setDeadlineDirty(true); }}
              style={{ width: 120, marginTop: 6 }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <button
                onClick={() => {
                  const n = Math.min(Math.max(parseInt(deadline, 10) || 12, 1), 168);
                  save({ job_deadline_hours: n }, 'Deadline');
                }}
                disabled={!deadlineDirty || saveMutation.isPending}>
                {saveMutation.isPending ? <span className="spinner" /> : 'Save deadline'}
              </button>
              <button className="secondary" disabled={!deadlineDirty || saveMutation.isPending}
                onClick={() => { setDeadline(String(data?.job_deadline_hours ?? 12)); setDeadlineDirty(false); }}>
                Discard changes
              </button>
              {deadlineDirty && <span className="muted" style={{ fontSize: '0.82rem' }}>Unsaved changes</span>}
            </div>
          </div>
        </>
      )}

      {subTab === 'notifications' && (() => {
        const setN = (patch: Partial<Notif>) => { setNotif({ ...notif, ...patch }); setNotifDirty(true); };
        const hours = Array.from({ length: 24 }, (_, h) => h);
        const row = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const };
        return (
          <>
            <p className="muted">
              Desktop reminders for an upcoming interview. Each one is sent on the{' '}
              <strong>recipient's own timezone</strong> — the caller's, or the creator's — never yours.
            </p>

            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12,
              background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.28)' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ fontSize: '1rem' }}>ℹ️</span>
                <span style={{ fontSize: '0.85rem' }}>
                  Only interviews whose <strong>Status is “Scheduled”</strong> ever notify. The moment a call becomes
                  Done, Closed, On-hold, Not Done — anything else — it goes silent on its own.
                </span>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ fontSize: '1rem' }}>✅</span>
                <span style={{ fontSize: '0.85rem' }}>
                  The <strong>Creator</strong> and <strong>Board mgr</strong> heads-ups additionally require{' '}
                  <strong>Approved is “Confirmed”</strong> — a call still Pending or Rejected doesn't page them yet.
                  The <strong>Caller</strong>'s reminder and the daily summary are not affected by Approved.
                </span>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ fontSize: '1rem' }}>👤</span>
                <span style={{ fontSize: '0.85rem' }}>
                  <strong>Creator</strong>/<strong>Board mgr</strong> lead times below are <strong>per person</strong> —
                  they save for <em>you</em>, the signed-in admin, not for everyone. Because this page is admin-only,
                  a Call Board Manager who isn't also an admin can't reach it and stays on the 90-minute default —
                  give them the admin role too if they need to set their own time.
                </span>
              </div>
            </div>

            <div className="card">
              <label style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)' }}>
                Before the call
              </label>
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                {/* Creator/CBM heads-ups: the toggle above is a whole-feature kill switch, admin-controlled
                    and saved with the rest of this tab. The TIME chips below are different — they save
                    THE SIGNED-IN ADMIN's own creator_lead_minutes_list/cbm_lead_minutes_list (via
                    saveReminders → /api/auth/me), not the shared settings blob. A single shared time here
                    used to mean one person's preference silently became everyone else's. */}
                <ReminderCard
                  on={notif.creator_enabled} onToggle={(v) => setN({ creator_enabled: v })}
                  icon="🗓️" title="Heads-up to whoever booked it" to="Creator"
                  when={<MinutesListEditor values={creatorMins} disabled={!notif.creator_enabled}
                    onChange={(v) => { setCreatorMins(v); setRemindersDirty(true); }} />}
                  note={<>Your <strong>own</strong> times — Creater is always the signed-in admin who books the call.
                    Names the caller. Sent <strong>once per time</strong>, even if you reschedule.
                    Requires Approved: Confirmed.</>}
                  preview={creatorMins.map((m) => `Interview you booked — in ${leadLabel(m)}`)} />

                {hasRole(user, 'call_board_manager') ? (
                  <ReminderCard
                    on={notif.cbm_enabled} onToggle={(v) => setN({ cbm_enabled: v })}
                    icon="📋" title="Heads-up to the call board manager" to="Board mgr"
                    when={<MinutesListEditor values={cbmMins} disabled={!notif.cbm_enabled}
                      onChange={(v) => { setCbmMins(v); setRemindersDirty(true); }} />}
                    note={<>Your <strong>own</strong> times, as a Call Board Manager. Sent for <em>every</em>
                      scheduled call, and it names the caller. Sent <strong>once per time</strong> per call.
                      Requires Approved: Confirmed.</>}
                    preview={cbmMins.map((m) => `Board interview — <creater> — in ${leadLabel(m)}`)} />
                ) : (
                  <ReminderCard
                    on={notif.cbm_enabled} onToggle={(v) => setN({ cbm_enabled: v })}
                    icon="📋" title="Heads-up to the call board manager" to="Board mgr"
                    when={<Hint>on — you aren't a Call Board Manager, so there's nothing of yours to set here;
                      each CBM sets their own time when they're signed in.</Hint>}
                    note="Sent to everyone with the Call Board Manager role, for every scheduled call. Requires Approved: Confirmed."
                    preview="Board interview — <creater> — in …" />
                )}

                <ReminderCard
                  on={notif.lead_enabled} onToggle={(v) => setN({ lead_enabled: v })}
                  icon="🔔" title="Just before the call" to="Caller"
                  when={<>
                    <input type="number" min={5} max={1440} value={notif.lead_minutes} disabled={!notif.lead_enabled}
                      onChange={(e) => setN({ lead_minutes: parseInt(e.target.value, 10) || 0 })}
                      style={{ flex: '0 0 auto', width: 82 }} />
                    <Hint>minutes before it starts — one per call</Hint>
                  </>}
                  preview={`Interview in ${leadLabel(notif.lead_minutes)}`} />
              </div>

              <label style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em',
                color: 'var(--muted)', display: 'block', marginTop: 22 }}>
                Daily summary
              </label>
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                <ReminderCard
                  on={notif.day_before_enabled} onToggle={(v) => setN({ day_before_enabled: v })}
                  icon="🌙" title="Evening before" to="Caller"
                  when={<>
                    <select value={notif.day_before_hour} disabled={!notif.day_before_enabled}
                      onChange={(e) => setN({ day_before_hour: parseInt(e.target.value, 10) })}
                      style={{ flex: '0 0 auto', width: 118 }}>
                      {hours.map((h) => <option key={h} value={h}>{hourName(h)}</option>)}
                    </select>
                    <Hint>the night before — one message for <em>all</em> of the next day's calls</Hint>
                  </>}
                  preview="2 interviews tomorrow" />

                <ReminderCard
                  on={notif.day_of_enabled} onToggle={(v) => setN({ day_of_enabled: v })}
                  icon="☀️" title="Morning of" to="Caller"
                  when={<>
                    <select value={notif.day_of_hour} disabled={!notif.day_of_enabled}
                      onChange={(e) => setN({ day_of_hour: parseInt(e.target.value, 10) })}
                      style={{ flex: '0 0 auto', width: 118 }}>
                      {hours.map((h) => <option key={h} value={h}>{hourName(h)}</option>)}
                    </select>
                    <Hint>one message for <em>all</em> of that day's calls</Hint>
                  </>}
                  preview="2 interviews today" />
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
                {/* ONE save button for the whole tab, even though it writes to two different places:
                    the toggles/hours above go to /api/settings (notifDirty), the Creator/CBM time chips
                    go to /api/auth/me — YOUR OWN times (remindersDirty). Two separate save buttons here
                    used to mean adding a time chip left THIS button disabled (its dirty flag hadn't
                    moved) while a second, easy-to-miss button elsewhere was the one that had lit up —
                    "I added a time and the save button stayed disabled". One button, one dirty flag. */}
                <button
                  onClick={async () => {
                    if (remindersDirty) await saveReminders();
                    if (notifDirty) save({
                      notifications: {
                        ...notif,
                        lead_minutes: Math.min(Math.max(notif.lead_minutes || 60, 5), 1440),
                      },
                    }, 'Notifications');
                  }}
                  disabled={(!notifDirty && !remindersDirty) || saveMutation.isPending || remindersSaving}>
                  {(saveMutation.isPending || remindersSaving) ? <span className="spinner" /> : 'Save notifications'}
                </button>
                <button className="secondary" disabled={(!notifDirty && !remindersDirty) || saveMutation.isPending || remindersSaving}
                  onClick={() => {
                    setNotif({ ...NOTIF_DEFAULTS, ...(data?.notifications || {}) }); setNotifDirty(false);
                    setCreatorMins(user?.creator_lead_minutes_list || []);
                    setCbmMins(user?.cbm_lead_minutes_list || []);
                    setRemindersDirty(false);
                  }}>
                  Discard changes
                </button>
                {(notifDirty || remindersDirty) && <span className="muted" style={{ fontSize: '0.82rem' }}>Unsaved changes</span>}
              </div>
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: 12, marginBottom: 0 }}>
                A reminder always states the time that is <strong>actually</strong> left, so it can never announce
                “in 90 minutes” for a call that is 40 minutes away. If a call is booked at such short notice that a
                reminder's moment has already gone, that one is skipped rather than sent late.
              </p>
            </div>
          </>
        );
      })()}

      {subTab === 'prompt' && (
        <>
          <p className="muted">Prompt Instructions — Section 1 of the per-job prompt copied into ChatGPT.</p>
          <div className="card">
            <label style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)' }}>
              Prompt template (instructions)
            </label>
            <textarea rows={30} value={template}
              onChange={(e) => { setTemplate(e.target.value); setPromptDirty(true); }}
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem', marginTop: 6 }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <button onClick={() => save({ prompt_template: template }, 'Prompt')} disabled={!promptDirty || saveMutation.isPending}>
                {saveMutation.isPending ? <span className="spinner" /> : 'Save prompt'}
              </button>
              <button className="secondary" disabled={!promptDirty || saveMutation.isPending}
                onClick={() => { setTemplate(String(data?.prompt_template || '')); setPromptDirty(false); }}>
                Discard changes
              </button>
              {promptDirty && <span className="muted" style={{ fontSize: '0.82rem' }}>Unsaved changes</span>}
            </div>
          </div>
        </>
      )}

      {subTab === 'domains' && listEditor({
        text: domainsText, setText: setDomainsText, dirty: domainsDirty, setDirty: setDomainsDirty,
        label: 'Blacklisted root domains', placeholder: 'lever.co\nworkday.com\nexample.io',
        field: 'blacklist_domains', what: 'Domains', saveKey: 'domains',
        help: <>Jobs whose link root domain matches any entry are rejected — from manual adds and the job-sync poller.
          One domain per line. Subdomains/schemes are stripped: <code>https://www.lever.co/foo</code> stores <code>lever.co</code>.</>,
      })}

      {subTab === 'titles' && listEditor({
        text: titlesText, setText: setTitlesText, dirty: titlesDirty, setDirty: setTitlesDirty,
        label: 'Blacklisted title keywords', placeholder: 'lead\nstaff\nprincipal\ndevops',
        field: 'blacklist_titles', what: 'Titles', saveKey: 'titles',
        help: <>If a job title <strong>contains</strong> any keyword below (case-insensitive substring), the job is rejected.
          One keyword per line. e.g. <code>lead</code> rejects "Team Lead" and "Lead Engineer".</>,
      })}

      {subTab === 'companies' && listEditor({
        text: companiesText, setText: setCompaniesText, dirty: companiesDirty, setDirty: setCompaniesDirty,
        label: 'Blacklisted companies', placeholder: 'Acme Inc\nBeta LLC',
        field: 'blacklist_companies', what: 'Companies', saveKey: 'companies',
        help: <>If a job's company name <strong>exactly</strong> matches an entry below (case-insensitive), the job is rejected.
          One company per line.</>,
      })}
    </div>
  );
}
