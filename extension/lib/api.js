// API client for the side panel. Session (JWT + user) lives in
// chrome.storage.local so it survives the panel closing.

const DEFAULT_API_BASE = 'https://tailorresume.duckdns.org';

export async function getConfig() {
  const { apiBase, token, user } = await chrome.storage.local.get(['apiBase', 'token', 'user']);
  return {
    apiBase: (apiBase || DEFAULT_API_BASE).replace(/\/+$/, ''),
    token: token || '',
    user: user || null,
  };
}

export async function setSession({ token, user }) {
  await chrome.storage.local.set({ token, user });
}

export async function clearSession() {
  await chrome.storage.local.remove(['token', 'user']);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function request(path, { method = 'GET', body, raw = false } = {}) {
  const { apiBase, token } = await getConfig();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  let resp;
  try {
    resp = await fetch(`${apiBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new ApiError('Network error — is the server reachable?', 0);
  }
  if (resp.status === 401) {
    await clearSession();
    throw new ApiError('Session expired — please sign in again.', 401);
  }
  if (raw) {
    if (!resp.ok) throw new ApiError(`Request failed (${resp.status})`, resp.status);
    return resp;
  }
  let data = null;
  try { data = await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok) {
    const detail = (data && (data.detail?.message || data.detail)) || `Request failed (${resp.status})`;
    throw new ApiError(typeof detail === 'string' ? detail : 'Request failed', resp.status);
  }
  return data;
}

export { ApiError };
