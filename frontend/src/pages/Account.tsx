import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { useAuth, loadCurrentUser } from '../lib/auth';

type ProfileForm = {
  full_name: string; email: string; country: string;
  telegram: string; whatsapp: string; discord: string; emergency_contacts: string; timezone: string;
};

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

export default function Account() {
  const { user } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<ProfileForm>({
    full_name: '', email: '', country: '', telegram: '', whatsapp: '', discord: '', emergency_contacts: '', timezone: '',
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwSaving, setPwSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    setForm({
      full_name: user.full_name || '', email: user.email || '', country: user.country || '',
      telegram: user.telegram || '', whatsapp: user.whatsapp || '', discord: user.discord || '',
      emergency_contacts: user.emergency_contacts || '', timezone: user.timezone || '',
    });
  }, [user]);

  if (!user) return <div><span className="spinner" /> Loading…</div>;

  const set = (k: keyof ProfileForm, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await api.patch('/api/auth/me', form);
      await loadCurrentUser();
      toast('Profile saved', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to save profile', 'error');
    } finally { setSaving(false); }
  };

  const onPickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.raw.post('/api/auth/me/avatar', fd);
      await loadCurrentUser();
      toast('Avatar updated', 'success');
    } catch (err: any) {
      const d = err?.response?.data;
      toast((d && (d.detail || d)) || 'Failed to upload avatar', 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const changePassword = async () => {
    if (pw.next.length < 10) { toast('Use at least 10 characters', 'error'); return; }
    if (pw.next !== pw.confirm) { toast('New passwords do not match', 'error'); return; }
    setPwSaving(true);
    try {
      await api.post('/api/auth/change-password', { current_password: pw.current, new_password: pw.next });
      setPw({ current: '', next: '', confirm: '' });
      toast('Password updated', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Failed to update password', 'error');
    } finally { setPwSaving(false); }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <h1>My Profile</h1>

      {/* Avatar + identity */}
      <div className="card" style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: '1rem' }}>
        <div style={{ width: 84, height: 84, borderRadius: '50%', overflow: 'hidden', flex: '0 0 auto',
          background: '#3b82f640', color: '#93c5fd', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '1.6rem', fontWeight: 700 }}>
          {user.avatar_url
            ? <img src={user.avatar_url} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : initials(user.full_name || user.username)}
        </div>
        <div>
          <div style={{ fontWeight: 600, fontSize: '1.05rem' }}>{user.full_name || user.username}</div>
          <div className="muted" style={{ fontSize: '0.82rem', marginBottom: 8 }}>@{user.username} · {(user.roles || []).join(', ') || '—'}</div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }} onChange={onPickAvatar} />
          <button className="secondary" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <span className="spinner" /> : 'Upload avatar'}
          </button>
          <span className="muted" style={{ fontSize: '0.78rem', marginLeft: 8 }}>PNG/JPG/WEBP/GIF, ≤ 3 MB</span>
        </div>
      </div>

      {/* Account details */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Account details</h2>
        <div className="row">
          <div className="field"><label>Full name</label><input value={form.full_name} onChange={(e) => set('full_name', e.target.value)} /></div>
          <div className="field"><label>Username</label><input value={user.username} disabled /></div>
        </div>
        <div className="row">
          <div className="field"><label>Email</label><input value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
          <div className="field"><label>Country</label><input value={form.country} onChange={(e) => set('country', e.target.value)} placeholder="e.g. Romania" /></div>
        </div>
        <div className="row">
          <div className="field"><label>Telegram</label><input value={form.telegram} onChange={(e) => set('telegram', e.target.value)} placeholder="@handle" /></div>
          <div className="field"><label>WhatsApp</label><input value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} placeholder="+1 555…" /></div>
        </div>
        <div className="row">
          <div className="field"><label>Discord</label><input value={form.discord} onChange={(e) => set('discord', e.target.value)} placeholder="user#0000" /></div>
          <div className="field">
            <label>Time zone</label>
            <TimezonePicker value={form.timezone} onChange={(tz) => set('timezone', tz)} />
            {BROWSER_TZ && form.timezone !== BROWSER_TZ && (
              <span className="muted" style={{ fontSize: '0.74rem', marginTop: 4, cursor: 'pointer', textDecoration: 'underline', width: 'fit-content' }}
                onClick={() => set('timezone', BROWSER_TZ)}>Use my detected zone ({tzDisplay(BROWSER_TZ)})</span>
            )}
          </div>
        </div>
        <div className="field">
          <label>Emergency contacts</label>
          <textarea rows={3} value={form.emergency_contacts} onChange={(e) => set('emergency_contacts', e.target.value)}
            placeholder="Name · relationship · phone (one per line)" />
        </div>
        <button onClick={save} disabled={saving}>{saving ? <span className="spinner" /> : 'Save profile'}</button>
      </div>

      {/* Change password */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Change password</h2>
        <div className="row">
          <div className="field"><label>Current password</label><input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
          <div className="field" />
        </div>
        <div className="row">
          <div className="field"><label>New password</label><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
          <div className="field"><label>Confirm new</label><input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></div>
        </div>
        <div className="muted" style={{ fontSize: '0.78rem', marginBottom: 8 }}>At least 10 characters, with a letter and a number.</div>
        <button onClick={changePassword} disabled={pwSaving || !pw.next}>{pwSaving ? <span className="spinner" /> : 'Update password'}</button>
      </div>
    </div>
  );
}
