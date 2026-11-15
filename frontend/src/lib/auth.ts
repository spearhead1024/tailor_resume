import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { closeLive } from './board-live';
import { syncPushIfGranted } from './push';

const TOKEN_KEY = 'tailorresume.token';

export type Role = 'admin' | 'bidder' | 'job_adder' | 'caller' | 'manager' | 'call_board_manager';

export type User = {
  id: string;
  username: string;
  full_name: string;
  email: string;
  roles: Role[];
  is_admin: boolean; // derived: 'admin' in roles
  team_id?: string;  // caller: the team they're in; manager: the team they run
  availability?: Record<string, { on: boolean; start: string; end: string }>;  // mon..sat working window
  // Meetings they have on their working days (standup, team sync, 1:1). Each sits INSIDE the working
  // window — at their desk, but not free to take a call — so the board cuts them out of the free time.
  daily_meetings?: { on: boolean; title: string; start: string; end: string; days: string[] }[];
  days_off?: string[];                                                          // YYYY-MM-DD they can't work
  status: string;
  assigned_profile_ids?: string[];
  force_password_change?: boolean;
  avatar_url?: string;
  country?: string;
  telegram?: string;
  whatsapp?: string;
  discord?: string;
  emergency_contacts?: string;
  timezone?: string;
  // This person's OWN interview-reminder heads-up lead times (minutes before the call) — set on their
  // own Account page, never by anyone else. Empty/absent = the system default applies. Meaningful only
  // if they're ever a Creater (an admin) or hold the call_board_manager role, but harmless otherwise.
  creator_lead_minutes_list?: number[];
  cbm_lead_minutes_list?: number[];
  // A caller's own CV + tech stacks (set on their Account page; only admins view them in the Users tab).
  tech_stacks?: string[];
  uploaded_resume?: { filename?: string; content_type?: string; size_bytes?: number; uploaded_at?: string };
};

export function hasRole(user: User | null, ...roles: Role[]): boolean {
  if (!user) return false;
  const set = new Set(user.roles || []);
  return roles.some((r) => set.has(r));
}

let currentUser: User | null = null;
const listeners = new Set<() => void>();

function notify() { listeners.forEach((l) => l()); }

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function setUser(user: User | null) {
  currentUser = user;
  notify();
}

export function getUser(): User | null { return currentUser; }

export function useAuth() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return { user: currentUser, token: getToken() };
}

export async function loadCurrentUser(): Promise<User | null> {
  if (!getToken()) {
    setUser(null);
    return null;
  }
  // Only a 401 means the session is gone. A reload during a deploy (502) or a network blip must not
  // throw away a valid token, so retry those for a few seconds while the boot spinner shows.
  for (let attempt = 0; ; attempt++) {
    try {
      const me = await api.get<User>('/api/auth/me');
      setUser(me);
      return me;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401 || attempt >= 3) {
        if (status === 401) setToken(null);
        setUser(null);
        return null;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

export async function login(identifier: string, password: string): Promise<User> {
  const res = await api.post<{ token: string; user: User }>('/api/auth/login', { identifier, password });
  setToken(res.token);
  setUser(res.user);
  // Re-register this browser's push subscription to the user who just signed in. It used to happen
  // only at app boot / on the Interviews page, so after a sign-out → sign-in (no reload) the browser
  // kept ringing with the PREVIOUS user's reminders until the next full page load.
  void syncPushIfGranted();
  return res.user;
}

/** Tell the server to stop pushing to THIS browser for the user signing out (best-effort). The
 *  browser keeps its subscription; the next sign-in re-registers it to the new user. */
async function forgetPushOnServer(token: string): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint },
        { headers: { Authorization: `Bearer ${token}` } });   // the token is cleared below — send it explicitly
    }
  } catch { /* best-effort */ }
}

export function logout() {
  const token = getToken();
  if (token) void forgetPushOnServer(token);
  // Tear the live socket down FIRST. It was opened with this user's JWT baked into the URL, and the
  // app is a SPA — signing out and back in never reloads the page, so a surviving socket would still
  // be authenticated as the person who just left. The next user to sign in on this browser would
  // inherit it and receive THEIR notifications and board rows. closeLive() drops it so the next
  // subscribe rebuilds a fresh socket with the new user's token.
  closeLive();
  setToken(null);
  setUser(null);
}
