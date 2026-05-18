import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../lib/auth';
import { api } from '../api/client';

export default function Login() {
  const [tab, setTab] = useState<'in' | 'up'>('in');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [signupFields, setSignupFields] = useState({ full_name: '', email: '', username: '', password: '' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await login(identifier, password);
      navigate('/todo');
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Sign-in failed');
    } finally { setBusy(false); }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSuccess(''); setBusy(true);
    try {
      await api.post('/api/auth/register', signupFields);
      setSuccess('Access requested. An admin will review your account.');
      setTab('in');
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Registration failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>TailorResume</h1>
        <div className="tabs" style={{ marginBottom: '1.5rem' }}>
          <button className={tab === 'in' ? 'active' : ''} onClick={() => setTab('in')}>Sign in</button>
          <button className={tab === 'up' ? 'active' : ''} onClick={() => setTab('up')}>Request access</button>
        </div>
        {error && <div className="banner error">{error}</div>}
        {success && <div className="banner success">{success}</div>}
        {tab === 'in' ? (
          <form onSubmit={handleSignIn}>
            <div className="field">
              <label>Username or email</label>
              <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus required />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <button type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? <span className="spinner" /> : 'Sign in'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSignUp}>
            <div className="field">
              <label>Full name</label>
              <input value={signupFields.full_name} onChange={(e) => setSignupFields({ ...signupFields, full_name: e.target.value })} required />
            </div>
            <div className="field">
              <label>Work email</label>
              <input type="email" value={signupFields.email} onChange={(e) => setSignupFields({ ...signupFields, email: e.target.value })} required />
            </div>
            <div className="field">
              <label>Username</label>
              <input value={signupFields.username} onChange={(e) => setSignupFields({ ...signupFields, username: e.target.value })} required />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" value={signupFields.password} onChange={(e) => setSignupFields({ ...signupFields, password: e.target.value })} required minLength={10} />
              <small className="muted">At least 10 characters with letters and numbers.</small>
            </div>
            <button type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? <span className="spinner" /> : 'Request access'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
