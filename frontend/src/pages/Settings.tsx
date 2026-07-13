import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../lib/toast';

type SubTab = 'general' | 'notifications' | 'prompt' | 'domains' | 'titles' | 'companies';

/* Interview reminder settings. Every time here is on the CALLER's clock (their profile timezone). */
type Notif = {
  lead_enabled: boolean; lead_minutes: number;
  day_before_enabled: boolean; day_before_hour: number;
  day_of_enabled: boolean; day_of_hour: number;
};
const NOTIF_DEFAULTS: Notif = {
  lead_enabled: true, lead_minutes: 60,
  day_before_enabled: true, day_before_hour: 19,   // 7pm
  day_of_enabled: true, day_of_hour: 8,            // 8am
};
const hourName = (h: number) => `${(h % 12) || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

function toLines(arr: any): string {
  return Array.isArray(arr) ? arr.join('\n') : '';
}
function parseList(text: string): string[] {
  return text.split(/[\n,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export default function Settings() {
  const qc = useQueryClient();
  const toast = useToast();
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
              Interview reminders pushed to the <strong>caller's</strong> desktop. Every time below is on the{' '}
              <strong>caller's own timezone</strong> (from their profile) — not yours. A caller with several calls on
              one day gets a <em>single</em> combined "today"/"tomorrow" notification, plus one reminder before each call.
            </p>
            <div className="card">
              <label style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)' }}>
                Interview reminders
              </label>

              <div style={{ display: 'grid', gap: 14, marginTop: 12 }}>
                <div style={row}>
                  <input type="checkbox" checked={notif.lead_enabled}
                    onChange={(e) => setN({ lead_enabled: e.target.checked })} />
                  <strong style={{ minWidth: 120 }}>Before each call</strong>
                  <input type="number" min={5} max={1440} value={notif.lead_minutes} disabled={!notif.lead_enabled}
                    onChange={(e) => setN({ lead_minutes: parseInt(e.target.value, 10) || 0 })}
                    style={{ width: 90 }} />
                  <span className="muted">minutes before it starts — e.g. <code>30</code> for half an hour, <code>60</code> for an hour</span>
                </div>

                <div style={row}>
                  <input type="checkbox" checked={notif.day_before_enabled}
                    onChange={(e) => setN({ day_before_enabled: e.target.checked })} />
                  <strong style={{ minWidth: 120 }}>Day before</strong>
                  <select value={notif.day_before_hour} disabled={!notif.day_before_enabled}
                    onChange={(e) => setN({ day_before_hour: parseInt(e.target.value, 10) })} style={{ width: 120 }}>
                    {hours.map((h) => <option key={h} value={h}>{hourName(h)}</option>)}
                  </select>
                  <span className="muted">the evening before — "N interviews tomorrow"</span>
                </div>

                <div style={row}>
                  <input type="checkbox" checked={notif.day_of_enabled}
                    onChange={(e) => setN({ day_of_enabled: e.target.checked })} />
                  <strong style={{ minWidth: 120 }}>Morning of</strong>
                  <select value={notif.day_of_hour} disabled={!notif.day_of_enabled}
                    onChange={(e) => setN({ day_of_hour: parseInt(e.target.value, 10) })} style={{ width: 120 }}>
                    {hours.map((h) => <option key={h} value={h}>{hourName(h)}</option>)}
                  </select>
                  <span className="muted">on the interview day — "N interviews today"</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
                <button
                  onClick={() => save({
                    notifications: { ...notif, lead_minutes: Math.min(Math.max(notif.lead_minutes || 60, 5), 1440) },
                  }, 'Notifications')}
                  disabled={!notifDirty || saveMutation.isPending}>
                  {saveMutation.isPending ? <span className="spinner" /> : 'Save notifications'}
                </button>
                <button className="secondary" disabled={!notifDirty || saveMutation.isPending}
                  onClick={() => { setNotif({ ...NOTIF_DEFAULTS, ...(data?.notifications || {}) }); setNotifDirty(false); }}>
                  Discard changes
                </button>
                {notifDirty && <span className="muted" style={{ fontSize: '0.82rem' }}>Unsaved changes</span>}
              </div>
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: 12, marginBottom: 0 }}>
                Changing a value re-arms the affected reminders, so an upcoming call whose new moment has already
                passed is sent right away (never a stale "tomorrow" once it's today).
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
