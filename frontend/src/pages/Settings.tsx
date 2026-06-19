import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../lib/toast';

type SubTab = 'general' | 'prompt' | 'domains' | 'titles' | 'companies';

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

  useEffect(() => {
    if (data) {
      setDeadline(String(data.job_deadline_hours ?? 12)); setDeadlineDirty(false);
      setTemplate(String(data.prompt_template || '')); setPromptDirty(false);
      setDomainsText(toLines(data.blacklist_domains)); setDomainsDirty(false);
      setTitlesText(toLines(data.blacklist_titles)); setTitlesDirty(false);
      setCompaniesText(toLines(data.blacklist_companies)); setCompaniesDirty(false);
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
