import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, Link } from 'react-router-dom';
import { loadCurrentUser, logout, useAuth } from './lib/auth';
import { ToastProvider } from './lib/toast';
import Login from './pages/Login';
import ToDo from './pages/ToDo';
import Jobs from './pages/Jobs';
import Resumes from './pages/Resumes';
import Profiles from './pages/Profiles';
import Users from './pages/Users';
import Settings from './pages/Settings';
import Metrics from './pages/Metrics';

function TopNav() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  if (!user) return null;
  const linkClass = (path: string) => loc.pathname.startsWith(path) ? 'active' : '';
  return (
    <nav className="topnav">
      <div className="brand">TailorResume</div>
      <div className="nav-links">
        <Link to="/todo" className={linkClass('/todo')}>To-Do</Link>
        {user.is_admin && <Link to="/jobs" className={linkClass('/jobs')}>Jobs</Link>}
        {user.is_admin && <Link to="/resumes" className={linkClass('/resumes')}>Resumes</Link>}
        <Link to="/profiles" className={linkClass('/profiles')}>Profiles</Link>
        <Link to="/metrics" className={linkClass('/metrics')}>Metrics</Link>
        {user.is_admin && <Link to="/users" className={linkClass('/users')}>Users</Link>}
        {user.is_admin && <Link to="/settings" className={linkClass('/settings')}>Settings</Link>}
      </div>
      <div className="spacer" />
      <div className="user-info">
        <div>{user.full_name || user.username}</div>
        <div className="muted" style={{ fontSize: '0.78rem' }}>
          {user.is_admin ? 'Admin' : 'Bidder'} · <a href="#" onClick={(e) => { e.preventDefault(); logout(); navigate('/login'); }}>Sign out</a>
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

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  if (!user) return <div className="content"><span className="spinner" /> Loading…</div>;
  if (!user.is_admin) return <Navigate to="/todo" replace />;
  return <>{children}</>;
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
          <Route path="/todo" element={<Private><ToDo /></Private>} />
          <Route path="/jobs" element={<AdminOnly><Jobs /></AdminOnly>} />
          <Route path="/resumes" element={<AdminOnly><Resumes /></AdminOnly>} />
          <Route path="/profiles" element={<Private><Profiles /></Private>} />
          <Route path="/metrics" element={<Private><Metrics /></Private>} />
          <Route path="/users" element={<AdminOnly><Users /></AdminOnly>} />
          <Route path="/settings" element={<AdminOnly><Settings /></AdminOnly>} />
          <Route path="/" element={<Navigate to="/todo" replace />} />
          <Route path="*" element={<Navigate to="/todo" replace />} />
        </Routes>
      </main>
    </div>
    </ToastProvider>
  );
}
