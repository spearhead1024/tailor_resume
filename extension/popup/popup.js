// Popup: login / account / settings. All work goes through the service worker.

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refresh() {
  const s = await send({ type: 'getSession' });
  $('apiBase').value = s.apiBase || '';
  if (s.authed) {
    $('login').classList.add('hidden');
    $('account').classList.remove('hidden');
    $('who').textContent = s.user?.full_name || s.user?.username || '—';
    // show version (best-effort)
    const v = await send({ type: 'extensionVersion' }).catch(() => null);
    if (v?.ok) $('ver').textContent = `v${v.version || '?'}`;
  } else {
    $('account').classList.add('hidden');
    $('login').classList.remove('hidden');
  }
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  const btn = $('loginBtn');
  const old = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;
  const res = await send({
    type: 'login',
    identifier: $('identifier').value.trim(),
    password: $('password').value,
  });
  btn.textContent = old; btn.disabled = false;
  if (res?.ok) { await refresh(); }
  else { $('loginErr').textContent = res?.error || 'Sign in failed'; }
});

$('saveApi').addEventListener('click', async () => {
  await send({ type: 'setApiBase', apiBase: $('apiBase').value.trim() });
  $('saveApi').textContent = 'Saved ✓';
  setTimeout(() => ($('saveApi').textContent = 'Save API URL'), 1200);
});

$('toggleBar').addEventListener('click', async () => {
  $('toggleErr').textContent = '';
  const res = await send({ type: 'toggleBarActiveTab' });
  if (res?.ok) { window.close(); }
  else { $('toggleErr').textContent = res?.error || "Can't show the bar on this page."; }
});

$('logout').addEventListener('click', async () => {
  await send({ type: 'logout' });
  await refresh();
});

refresh();
