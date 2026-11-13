// The side panel's handle on the ChatGPT connection (gpt/runner.js runs in the service
// worker; ChatGPT itself runs hidden in its offscreen document). Reads come straight from
// chrome.storage; every change is a message to the worker, which is the only writer.

export const GPT_KEYS = { threads: 'gptThreads', state: 'gptState' };
export const CHAT_ORIGINS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
export const CHAT_URL = 'https://chatgpt.com/';
export const PARALLEL = 3;   // hidden ChatGPT frames at once = jobs prepared ahead (the job on screen + 2)
export const threadKey = (profileId, jobId) => `${profileId}:${jobId}`;

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
