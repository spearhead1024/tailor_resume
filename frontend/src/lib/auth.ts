import { useEffect, useState } from 'react';
import { api } from '../api/client';

const TOKEN_KEY = 'tailorresume.token';

export type User = {
  id: string;
  username: string;
  full_name: string;
  email: string;
  is_admin: boolean;
  status: string;
  assigned_profile_ids?: string[];
  force_password_change?: boolean;
};

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
  setToken(null);
  setUser(null);
}
