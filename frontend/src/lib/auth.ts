import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { closeLive } from './board-live';

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
  bid_method?: 1 | 2;        // 1 = Resumes + Apply tabs, 2 = Bid tab
  force_password_change?: boolean;
  avatar_url?: string;
  country?: string;
  telegram?: string;
  whatsapp?: string;
  discord?: string;
  emergency_contacts?: string;
  timezone?: string;
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
  try {
    const me = await api.get<User>('/api/auth/me');
    setUser(me);
    return me;
  } catch {
    setToken(null);
    setUser(null);
    return null;
  }
}

export async function login(identifier: string, password: string): Promise<User> {
  const res = await api.post<{ token: string; user: User }>('/api/auth/login', { identifier, password });
  setToken(res.token);
  setUser(res.user);
  return res.user;
}

export function logout() {
  // Tear the live socket down FIRST. It was opened with this user's JWT baked into the URL, and the
  // app is a SPA — signing out and back in never reloads the page, so a surviving socket would still
  // be authenticated as the person who just left. The next user to sign in on this browser would
  // inherit it and receive THEIR notifications and board rows. closeLive() drops it so the next
  // subscribe rebuilds a fresh socket with the new user's token.
  closeLive();
  setToken(null);
  setUser(null);
}
