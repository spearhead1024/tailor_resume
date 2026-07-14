import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, Link } from 'react-router-dom';
import { hasRole, loadCurrentUser, logout, useAuth, Role, User } from './lib/auth';
import NotifCenter from './lib/NotifCenter';
import { ToastProvider } from './lib/toast';
import Login from './pages/Login';
import Bid from './pages/Bid';
import Resumes from './pages/Resumes';
import Apply from './pages/Apply';
import Jobs from './pages/Jobs';
import Profiles from './pages/Profiles';
import Users from './pages/Users';
import Settings from './pages/Settings';
import Metrics from './pages/Metrics';
import Devices from './pages/Devices';
import Help from './pages/Help';
import Applied from './pages/Applied';
import Screenshots from './pages/Screenshots';
import Interviews from './pages/Interviews';
import Account from './pages/Account';
import AvailabilityPage from './pages/Availability';

/** Tab → roles allowed. Admin always has access. Order = display order. */
const TABS: { path: string; label: string; roles: Role[]; method?: 1 | 2 }[] = [
  { path: '/interviews', label: 'Interviews', roles: ['admin', 'caller', 'manager'] },
  // Callers and team managers only: an admin never takes a call, so they have no hours to set —
  // they read everyone else's on the calendar instead.
  { path: '/availability', label: 'Availability', roles: ['caller', 'manager'] },
  { path: '/jobs',     label: 'Jobs',     roles: ['admin', 'job_adder'] },
  { path: '/bid',      label: 'Bid',      roles: ['admin', 'bidder'], method: 2 },
  { path: '/resumes',  label: 'Resumes',  roles: ['admin', 'bidder'], method: 1 },
  { path: '/apply',    label: 'Apply',    roles: ['admin', 'bidder'], method: 1 },
  { path: '/applied',  label: 'Applied',  roles: ['admin'] },
  { path: '/screenshots', label: 'Screenshots', roles: ['admin'] },
  { path: '/metrics',  label: 'Metrics',  roles: ['admin', 'bidder', 'job_adder'] },
  { path: '/help', label: 'Help', roles: ['admin'] },
  { path: '/profiles', label: 'Profiles', roles: ['admin'] },
  // A team manager reaches Users to run their own team (create/approve its callers). The page and
  // the API both scope them to that team — they never see or touch anyone else.
  { path: '/users',    label: 'Users',    roles: ['admin', 'manager'] },
  { path: '/sessions', label: 'Sessions', roles: ['admin'] },
  { path: '/settings', label: 'Settings', roles: ['admin'] },
];

function roleLabel(roles: Role[]): string {
  if (!roles || roles.length === 0) return '—';
  const pretty: Partial<Record<Role, string>> = { job_adder: 'Job-Adder', manager: 'Team Manager' };
  return roles.map((r) => pretty[r] ?? (r.charAt(0).toUpperCase() + r.slice(1))).join(' · ');
}

/** Tabs the user may see: role-allowed, and (for Bid/Resumes/Apply) matching their
 *  assigned bid method. Admins see every method. */
function visibleTabs(user: User) {
  return TABS.filter((t) => hasRole(user, ...t.roles)
    && (!t.method || user.is_admin || (user.bid_method ?? 2) === t.method));
}

function defaultLandingPath(user: User | null): string {
  if (!user) return '/login';
  const v = visibleTabs(user);
  return v.length ? v[0].path : '/login';
}

function TopNav() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  if (!user) return null;
  const linkClass = (path: string) => loc.pathname.startsWith(path) ? 'active' : '';
  const visible = visibleTabs(user);
  return (
    <nav className="topnav">
      <div className="brand">TailorResume</div>
      <div className="nav-links">
        {visible.map((t) => (
          <Link key={t.path} to={t.path} className={linkClass(t.path)}>{t.label}</Link>
        ))}
      </div>
      <div className="spacer" />
      <NotifCenter />
      <div className="user-info">
        <div><Link to="/account" style={{ color: 'inherit', textDecoration: 'none' }}>{user.full_name || user.username}</Link></div>
        <div className="muted" style={{ fontSize: '0.78rem' }}>
          <Link to="/account">Account</Link> · <a href="#" onClick={(e) => { e.preventDefault(); logout(); navigate('/login'); }}>Sign out</a>
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
  if (!hasRole(user, ...roles)) return <Navigate to={defaultLandingPath(user)} replace />;
  return <>{children}</>;
}

function LandingRedirect() {
  const { user } = useAuth();
  return <Navigate to={defaultLandingPath(user)} replace />;
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
          <Route path="/bid"      element={<RoleGate roles={['admin', 'bidder']}><Bid /></RoleGate>} />
          <Route path="/resumes"  element={<RoleGate roles={['admin', 'bidder']}><Resumes /></RoleGate>} />
          <Route path="/apply"    element={<RoleGate roles={['admin', 'bidder']}><Apply /></RoleGate>} />
          <Route path="/interviews" element={<RoleGate roles={['admin', 'caller', 'manager']}><Interviews /></RoleGate>} />
          <Route path="/availability" element={<RoleGate roles={['caller', 'manager']}><AvailabilityPage /></RoleGate>} />
          <Route path="/jobs"     element={<RoleGate roles={['admin', 'job_adder']}><Jobs /></RoleGate>} />
          <Route path="/applied"  element={<RoleGate roles={['admin']}><Applied /></RoleGate>} />
          <Route path="/screenshots" element={<RoleGate roles={['admin']}><Screenshots /></RoleGate>} />
          <Route path="/metrics"  element={<RoleGate roles={['admin', 'bidder', 'job_adder']}><Metrics /></RoleGate>} />
          <Route path="/help" element={<RoleGate roles={['admin']}><Help /></RoleGate>} />
          <Route path="/profiles" element={<RoleGate roles={['admin']}><Profiles /></RoleGate>} />
          <Route path="/users"    element={<RoleGate roles={['admin', 'manager']}><Users /></RoleGate>} />
          <Route path="/sessions" element={<RoleGate roles={['admin']}><Devices /></RoleGate>} />
          <Route path="/settings" element={<RoleGate roles={['admin']}><Settings /></RoleGate>} />
          <Route path="/account"  element={<Private><Account /></Private>} />
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
