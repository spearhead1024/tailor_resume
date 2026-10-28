import axios, { AxiosRequestConfig } from 'axios';
import { getToken, logout } from '../lib/auth';

const axiosInstance = axios.create({
  baseURL: '',
  timeout: 120_000,
});

axiosInstance.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

// An expired or revoked session (Sessions → revoke, or the 30-day token running out) made every
// request 401 while the tab still looked signed in: failing pages and error toasts until a manual
// reload. Sign out and go to the login page instead. Only for requests that CARRIED a token (so the
// login form's own "invalid credentials" 401 is left to the form), and never from /login itself.
axiosInstance.interceptors.response.use(undefined, (error) => {
  const cfg = error?.config;
  const sentToken = !!cfg?.headers?.get?.('Authorization');
  if (error?.response?.status === 401 && sentToken && !String(cfg?.url || '').startsWith('/api/auth/login')) {
    logout();
    if (window.location.pathname !== '/login') window.location.replace('/login');
  }
  return Promise.reject(error);
});

async function request<T>(method: string, url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const res = await axiosInstance.request<T>({ method, url, data, ...(config || {}) });
  return res.data;
}

export const api = {
  get: <T>(url: string, config?: AxiosRequestConfig) => request<T>('get', url, undefined, config),
  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => request<T>('post', url, data, config),
  put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => request<T>('put', url, data, config),
  patch: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => request<T>('patch', url, data, config),
  delete: <T>(url: string, config?: AxiosRequestConfig) => request<T>('delete', url, undefined, config),
  raw: axiosInstance,
};
