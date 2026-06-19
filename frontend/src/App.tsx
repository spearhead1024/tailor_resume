import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, Link } from 'react-router-dom';
import { hasRole, loadCurrentUser, logout, useAuth, Role } from './lib/auth';
import { ToastProvider } from './lib/toast';
import Login from './pages/Login';
import Apply from './pages/Apply';
import Jobs from './pages/Jobs';
import Resumes from './pages/Resumes';
import Profiles from './pages/Profiles';
import Users from './pages/Users';
import Settings from './pages/Settings';
import Metrics from './pages/Metrics';
import Devices from './pages/Devices';
import Help from './pages/Help';
import Applied from './pages/Applied';
import Screenshots from './pages/Screenshots';

/** Tab → roles allowed. Admin always has access. Order = display order. */
const TABS: { path: string; label: string; roles: Role[] }[] = [
  { path: '/jobs',     label: 'Jobs',     roles: ['admin', 'job_adder'] },
  { path: '/resumes',  label: 'Resumes',  roles: ['admin', 'bidder'] },
  { path: '/apply',    label: 'Apply',    roles: ['admin', 'bidder'] },
  { path: '/applied',  label: 'Applied',  roles: ['admin'] },
  { path: '/screenshots', label: 'Screenshots', roles: ['admin'] },
  { path: '/metrics',  label: 'Metrics',  roles: ['admin', 'bidder', 'job_adder'] },
  { path: '/help', label: 'Help', roles: ['admin'] },
  { path: '/profiles', label: 'Profiles', roles: ['admin'] },
  { path: '/users',    label: 'Users',    roles: ['admin'] },
  { path: '/sessions', label: 'Sessions', roles: ['admin'] },
  { path: '/settings', label: 'Settings', roles: ['admin'] },
];

function roleLabel(roles: Role[]): string {
  if (!roles || roles.length === 0) return '—';
  return roles.map((r) => r === 'job_adder' ? 'Job-Adder' : r.charAt(0).toUpperCase() + r.slice(1)).join(' · ');
}

function defaultLandingPath(roles: Role[]): string {
  // Pick the first tab the user has access to in display order.
  for (const t of TABS) {
    if (t.roles.some((r) => roles.includes(r))) return t.path;
  }
  return '/login';
}

function TopNav() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  if (!user) return null;
  const linkClass = (path: string) => loc.pathname.startsWith(path) ? 'active' : '';
  const visible = TABS.filter((t) => hasRole(user, ...t.roles));
  return (
    <nav className="topnav">
      <div className="brand">TailorResume</div>
      <div className="nav-links">
        {visible.map((t) => (
          <Link key={t.path} to={t.path} className={linkClass(t.path)}>{t.label}</Link>
        ))}
      </div>
      <div className="spacer" />
      <div className="user-info">
        <div>{user.full_name || user.username}</div>
        <div className="muted" style={{ fontSize: '0.78rem' }}>
          {roleLabel(user.roles)} · <a href="#" onClick={(e) => { e.preventDefault(); logout(); navigate('/login'); }}>Sign out</a>
        </div>
      </div>
    </nav>
  );
}

function Private({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  if (!user) return <div className="content"><span className="spinner" /> Loading…</div>;
  return <>{children}</>;
}

function RoleGate({ roles, children }: { roles: Role[]; children: React.ReactNode }) {
  const { user, token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  if (!user) return <div className="content"><span className="spinner" /> Loading…</div>;
  if (!hasRole(user, ...roles)) return <Navigate to={defaultLandingPath(user.roles)} replace />;
  return <>{children}</>;
}

function LandingRedirect() {
  const { user } = useAuth();
  return <Navigate to={user ? defaultLandingPath(user.roles) : '/login'} replace />;
}

export default function App() {
  const [bootLoading, setBootLoading] = useState(true);
  useEffect(() => {
    loadCurrentUser().finally(() => setBootLoading(false));
  }, []);

  if (bootLoading) {
    return <div className="login-shell"><span className="spinner" /> Loading…</div>;
  }

  return (
    <ToastProvider>
    <div className="layout">
      <TopNav />
      <main className="content">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/resumes"  element={<RoleGate roles={['admin', 'bidder']}><Resumes /></RoleGate>} />
          <Route path="/apply"    element={<RoleGate roles={['admin', 'bidder']}><Apply /></RoleGate>} />
          <Route path="/jobs"     element={<RoleGate roles={['admin', 'job_adder']}><Jobs /></RoleGate>} />
          <Route path="/applied"  element={<RoleGate roles={['admin']}><Applied /></RoleGate>} />
          <Route path="/screenshots" element={<RoleGate roles={['admin']}><Screenshots /></RoleGate>} />
          <Route path="/metrics"  element={<RoleGate roles={['admin', 'bidder', 'job_adder']}><Metrics /></RoleGate>} />
          <Route path="/help" element={<RoleGate roles={['admin']}><Help /></RoleGate>} />
          <Route path="/profiles" element={<RoleGate roles={['admin']}><Profiles /></RoleGate>} />
          <Route path="/users"    element={<RoleGate roles={['admin']}><Users /></RoleGate>} />
          <Route path="/sessions" element={<RoleGate roles={['admin']}><Devices /></RoleGate>} />
          <Route path="/settings" element={<RoleGate roles={['admin']}><Settings /></RoleGate>} />
          {/* Back-compat redirects */}
          <Route path="/todo"      element={<Navigate to="/apply" replace />} />
          <Route path="/devices"   element={<Navigate to="/sessions" replace />} />
          <Route path="/extension" element={<Navigate to="/help" replace />} />
          <Route path="/"        element={<Private><LandingRedirect /></Private>} />
          <Route path="*"        element={<Private><LandingRedirect /></Private>} />
        </Routes>
      </main>
    </div>
    </ToastProvider>
  );
}
