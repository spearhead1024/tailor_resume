// Shared API client for the service worker. All network calls go through the
// background worker (not content scripts) so page CSP can't block them and the
// JWT never touches page context.
//
// Config + token live in chrome.storage.local.

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

export async function setApiBase(apiBase) {
  await chrome.storage.local.set({ apiBase: (apiBase || DEFAULT_API_BASE).replace(/\/+$/, '') });
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, isForm = false, raw = false } = {}) {
  const { apiBase, token } = await getConfig();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let payload = body;
  if (body && !isForm) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let resp;
  try {
    resp = await fetch(`${apiBase}${path}`, { method, headers, body: payload });
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

export const api = {
  login: (identifier, password) =>
    request('/api/auth/login', { method: 'POST', body: { identifier, password, ttl_days: 30 } }),
  me: () => request('/api/auth/me'),
  profilesMeta: () => request('/api/todo?for=apply'),
  profileFull: (id) => request(`/api/profiles/${encodeURIComponent(id)}`),
  findResumeByUrl: (profileId, url) =>
    request(`/api/resumes/by-job-url?profile_id=${encodeURIComponent(profileId)}&url=${encodeURIComponent(url)}`),
  resumePdf: (resumeId) => request(`/api/resumes/${encodeURIComponent(resumeId)}/pdf`, { raw: true }),
  markApplied: (resumeId) => request(`/api/resumes/${encodeURIComponent(resumeId)}/apply`, { method: 'POST' }),
  reportJob: (jobId, reason) =>
    request(`/api/jobs/${encodeURIComponent(jobId)}/reports`, { method: 'POST', body: { reason } }),
  uploadScreenshot: (form) => request('/api/screenshots', { method: 'POST', body: form, isForm: true }),
  extensionVersion: () => request('/api/extension/version'),
  shortcuts: () => request('/api/auth/shortcuts'),
};

export { ApiError };
