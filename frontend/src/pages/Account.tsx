import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { useAuth, loadCurrentUser } from '../lib/auth';

type ProfileForm = {
  full_name: string; email: string; country: string;
  telegram: string; whatsapp: string; discord: string; emergency_contacts: string;
};

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
    full_name: '', email: '', country: '', telegram: '', whatsapp: '', discord: '', emergency_contacts: '',
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
      emergency_contacts: user.emergency_contacts || '',
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
        {/* Left column = identity, right column = how to reach them / where they are. */}
        <div className="row">
          <div className="field"><label>Full name</label><input value={form.full_name} onChange={(e) => set('full_name', e.target.value)} /></div>
          <div className="field"><label>WhatsApp</label><input value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} placeholder="+1 555…" /></div>
        </div>
        <div className="row">
          <div className="field"><label>Username</label><input value={user.username} disabled /></div>
          <div className="field"><label>Telegram</label><input value={form.telegram} onChange={(e) => set('telegram', e.target.value)} placeholder="@handle" /></div>
        </div>
        <div className="row">
          <div className="field"><label>Email</label><input value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
          <div className="field"><label>Discord</label><input value={form.discord} onChange={(e) => set('discord', e.target.value)} placeholder="user#0000" /></div>
        </div>
        <div className="row">
          <div className="field"><label>Location</label><input value={form.country} onChange={(e) => set('country', e.target.value)} placeholder="e.g. Romania" /></div>
          <div className="field">
            <label>Time zone</label>
            {/* Set on the Availability page, next to the hours it gives meaning to — a time is
                nothing without the clock it is on, and the board needs both. */}
            <Link to="/availability" className="link" style={{ fontSize: '0.85rem' }}>
              {user?.timezone ? `${user.timezone} — change on Availability` : 'Set it on the Availability page'}
            </Link>
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
