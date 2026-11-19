// The side panel's handle on the ChatGPT connection (gpt/runner.js runs in the service
// worker; ChatGPT itself runs in real background tabs it opens). Reads come straight from
// chrome.storage; every change is a message to the worker, which is the only writer.

export const GPT_KEYS = { threads: 'gptThreads', state: 'gptState' };
export const CHAT_ORIGINS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
export const CHAT_URL = 'https://chatgpt.com/';
export const PARALLEL = 1;   // ONE ChatGPT tab: it writes the CVs of the jobs ahead (the server's queue of 2) one after another, and answers questions first
export const threadKey = (profileId, jobId) => `${profileId}:${jobId}`;

// Which ChatGPT model writes what (⚙ Settings → ChatGPT models). Names as ChatGPT's model menu shows
// them; '' = leave ChatGPT's own choice. Tech questions go to Instant by default — the reply comes in
// seconds instead of the minute a thinking model takes; the CV keeps the account's model.
export const GPT_MODELS_KEY = 'gptModels';
export const MODEL_CHOICES = ['Instant', 'Thinking', 'Auto', 'Pro'];
export const DEFAULT_MODELS = { answers: 'Instant', cv: '' };
export async function gptModels() {
  const got = (await chrome.storage.local.get(GPT_MODELS_KEY).catch(() => ({})))[GPT_MODELS_KEY] || {};
  const pick = (v, d) => (typeof v === 'string' ? v.trim().slice(0, 40) : d);
  return { answers: pick(got.answers, DEFAULT_MODELS.answers), cv: pick(got.cv, DEFAULT_MODELS.cv) };
}

export async function gptSnapshot() {
  const got = await chrome.storage.local.get(Object.values(GPT_KEYS)).catch(() => ({}));
  return {
    threads: got[GPT_KEYS.threads] || {},
    state: { enabled: false, status: 'off', notice: '', cooldownUntil: 0, ...(got[GPT_KEYS.state] || {}) },
  };
}

export function onGptChange(fn) {
  const keys = new Set(Object.values(GPT_KEYS));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => keys.has(k))) fn(changes);
  });
}

export async function gpt(action, args = {}) {
  const res = await chrome.runtime.sendMessage({ type: 'gpt', action, ...args });
  if (res && res.ok === false && res.error) throw new Error(res.error);
  return res;
}

// Ask for chatgpt.com access. Chrome only shows the prompt from a click: call this as the
// FIRST await of the click handler.
export const requestChatAccess = () => chrome.permissions.request({ origins: CHAT_ORIGINS }).catch(() => false);
