import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth, hasRole } from '../lib/auth';
import { useToast } from '../lib/toast';

type ExtMeta = {
  version: string;
  extension_id: string;
  changelog: string;
  built_at: string;
  available: boolean;
  zip_url: string;
  crx_url: string;
  update_url: string;
};

const BASE = 'https://tailorresume.duckdns.org';
type Sub = 'extension' | 'guide' | 'shortcuts';

export default function Help() {
  const [sub, setSub] = useState<Sub>('extension');

  const tabBtn = (k: Sub, label: string) => (
    <button
      onClick={() => setSub(k)}
      style={{
        background: 'transparent', border: 'none', borderRadius: 0,
        borderBottom: `2px solid ${sub === k ? 'var(--accent, #2563eb)' : 'transparent'}`,
        color: sub === k ? 'var(--text)' : 'var(--muted)',
        fontWeight: sub === k ? 700 : 400, padding: '8px 16px', fontSize: '0.95rem',
      }}>
      {label}
    </button>
  );

  return (
    <div>
      <h1>Help</h1>
      <div style={{ display: 'flex', gap: 4, marginBottom: '1.25rem', borderBottom: '1px solid var(--border)' }}>
        {tabBtn('extension', '🧩 Extension')}
        {tabBtn('guide', '🎬 Guide')}
        {tabBtn('shortcuts', '⌨️ Shortcuts')}
      </div>

      {sub === 'extension' && <ExtensionGuide />}
      {sub === 'guide' && <GuideVideo />}
      {sub === 'shortcuts' && <ShortcutsSettings />}
    </div>
  );
}

// ─── Subtab 1: install / update the extension ───────────────────────────────
function ExtensionGuide() {
  const { data, isLoading } = useQuery({
    queryKey: ['extension', 'version'],
    queryFn: () => api.get<ExtMeta>('/api/extension/version'),
  });
  const [tab, setTab] = useState<'quick' | 'auto'>('quick');

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  const zipUrl = data?.zip_url || `${BASE}/api/extension/latest.zip`;
  const extId = data?.extension_id || '';

  return (
    <div>
      <p className="muted">
        The TailorResume Assistant adds a bar to the top of every tab so bidders can find &amp; download the
        right resume for the job page they're viewing, copy profile fields, report jobs, and screenshot —
        without leaving the page.
      </p>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)' }}>
              Current version
            </div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>v{data?.version || '—'}</div>
          </div>
          <div style={{ flex: 1 }} />
          {data?.available
            ? <a href={zipUrl} download><button>⬇ Download extension (.zip)</button></a>
            : <span className="pill rejected">Not published yet</span>}
        </div>
        {data?.built_at && (
          <div className="muted" style={{ fontSize: '0.82rem', marginTop: 8 }}>
            Built {new Date(data.built_at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET
            {extId && <> · ID <code>{extId}</code></>}
          </div>
        )}
        {data?.changelog && (
          <div style={{ marginTop: 10, fontSize: '0.88rem', whiteSpace: 'pre-wrap' }}>
            <strong>What's new:</strong> {data.changelog}
          </div>
        )}
      </div>

      <div className="card" style={{ background: 'var(--panel-2)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
        👉 <strong>Pick ONE install method below — not both.</strong> They install the same extension two different ways:
        <ul style={{ margin: '6px 0 0', lineHeight: 1.6 }}>
          <li><strong>Auto-update setup</strong> — Chrome installs it for you and keeps it updated. You do <em>not</em> download the zip or “Load unpacked.”</li>
          <li><strong>Manual install</strong> — you download the zip and load it yourself. Simple, but it never auto-updates.</li>
        </ul>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: '1rem', borderBottom: '1px solid var(--border)' }}>
        <button onClick={() => setTab('quick')}
          style={{
            background: 'transparent', border: 'none', borderRadius: 0,
            borderBottom: `2px solid ${tab === 'quick' ? 'var(--accent, #2563eb)' : 'transparent'}`,
            color: tab === 'quick' ? 'var(--text)' : 'var(--muted)',
            fontWeight: tab === 'quick' ? 700 : 400, padding: '8px 14px',
          }}>
          📦 Manual install
        </button>
        <button onClick={() => setTab('auto')}
          style={{
            background: 'transparent', border: 'none', borderRadius: 0,
            borderBottom: `2px solid ${tab === 'auto' ? 'var(--accent, #2563eb)' : 'transparent'}`,
            color: tab === 'auto' ? 'var(--text)' : 'var(--muted)',
            fontWeight: tab === 'auto' ? 700 : 400, padding: '8px 14px',
          }}>
          🔄 Auto-update setup
        </button>
      </div>

      {tab === 'quick' && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>Manual install — Load unpacked (~1 min)</h2>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Simplest way to get going. To update later, re-download and click the reload icon (no auto-update).
          </p>
          {data?.available && (
            <a href={zipUrl} download style={{ display: 'inline-block', marginBottom: 12 }}>
              <button>⬇ Download extension (.zip)</button>
            </a>
          )}
          <ol style={{ lineHeight: 1.8, fontSize: '0.9rem' }}>
            <li><strong>Extract</strong> the downloaded <code>.zip</code> to a folder you'll keep
              (e.g. <code>Documents/tailorresume-extension</code>).</li>
            <li>Open <code>chrome://extensions</code>.</li>
            <li>Turn <strong>Developer mode</strong> ON (top-right).</li>
            <li>Click <strong>Load unpacked</strong> → select the <strong>extracted folder</strong>.</li>
            <li>Pin the TailorResume icon, click it, and <strong>sign in</strong> with your TailorResume username &amp; password.</li>
          </ol>
          <div className="card" style={{ background: 'var(--panel-2)', fontSize: '0.82rem' }}>
            ⚠️ Don't drag the <code>.crx</code> onto the page — Chrome blocks self-hosted <code>.crx</code> drag-installs
            (<code>CRX_REQUIRED_PROOF_MISSING</code>). Use the <strong>.zip + Load unpacked</strong> steps above.
          </div>
          <p className="muted" style={{ fontSize: '0.82rem', marginTop: 10 }}>
            <strong>Updating:</strong> when this page shows a newer version, re-download the .zip, replace the folder's
            contents, and click the ↻ reload icon on the extension card. The bar also nudges you when an update is available.
          </p>
        </div>
      )}

      {tab === 'auto' && <AutoUpdateGuide extId={extId} />}
    </div>
  );
}

// ─── Subtab 2: guide video (admin uploads, everyone watches) ────────────────
type VideoMeta = { available: boolean; content_type?: string; bytes?: number; uploaded_at?: string; original_name?: string };

function GuideVideo() {
  const { user } = useAuth();
  const toast = useToast();
  const isAdmin = hasRole(user, 'admin');
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // cache-bust the <video> after a new upload
  const [v, setV] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const [videoUrl, setVideoUrl] = useState('');
  const [vidLoading, setVidLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try { setMeta(await api.get<VideoMeta>('/api/guide/video/meta')); }
    catch { setMeta({ available: false }); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  // Fetch the video as an AUTHENTICATED blob (the endpoint requires login), so
  // the raw URL can't be opened/shared by anyone who isn't signed in, and the
  // player shows a blob: URL rather than the server path.
  useEffect(() => {
    let url = '';
    let alive = true;
    if (meta?.available) {
      setVidLoading(true);
      api.raw.get('/api/guide/video', { responseType: 'blob' })
        .then((res) => { if (!alive) return; url = URL.createObjectURL(res.data as Blob); setVideoUrl(url); })
        .catch(() => { if (alive) setVideoUrl(''); })
        .finally(() => { if (alive) setVidLoading(false); });
    } else {
      setVideoUrl('');
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [meta?.available, v]);

  async function upload(file: File) {
    if (file.size > 300 * 1024 * 1024) {
      toast('Video too large (max 300 MB).', 'error');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('video', file);
      // Large videos over a slow link can exceed the default 120s timeout.
      await api.post('/api/guide/video', form, { timeout: 600_000 });
      toast('Guide video uploaded', 'success');
      setV((n) => n + 1);
      await refresh();
    } catch (e: any) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail
        || (status === 413 ? 'Video too large for the server.' : status ? `Upload failed (${status}).` : 'Upload failed — check your connection.');
      toast(detail, 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove() {
    if (!window.confirm('Remove the guide video?')) return;
    setBusy(true);
    try {
      await api.delete('/api/guide/video');
      toast('Guide video removed', 'success');
      await refresh();
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Delete failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div><span className="spinner" /> Loading…</div>;

  return (
    <div>
      <div className="card" style={{ marginBottom: '1rem' }}>
        {meta?.available ? (
          (vidLoading || !videoUrl) ? (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 10, minHeight: 280, color: 'var(--muted)', background: '#000', borderRadius: 10,
            }}>
              <span className="spinner" /> Loading video…
            </div>
          ) : (
            <video
              key={v}
              controls
              controlsList="nodownload noplaybackrate noremoteplayback"
              disablePictureInPicture
              onContextMenu={(e) => e.preventDefault()}
              style={{ width: '100%', maxHeight: '70vh', borderRadius: 10, background: '#000', display: 'block' }}
              src={videoUrl}
            />
          )
        ) : (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 8, minHeight: 280, color: 'var(--muted)', background: 'var(--panel-2)', borderRadius: 10,
          }}>
            <div style={{ fontSize: '2.4rem' }}>🎬</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text)' }}>Coming soon</div>
            <div style={{ fontSize: '0.85rem' }}>A walkthrough video will appear here.</div>
          </div>
        )}
        {meta?.available && meta.uploaded_at && (
          <div className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>
            Uploaded {new Date(meta.uploaded_at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET
            {meta.original_name ? <> · {meta.original_name}</> : null}
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="card">
          <div className="section-title" style={{ marginBottom: 8 }}>Admin — manage the guide video</div>
          <p className="muted" style={{ fontSize: '0.84rem', marginTop: 0 }}>
            Upload an MP4 / WebM / MOV (max 300 MB). A new upload replaces the current video.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={fileRef}
              type="file"
              accept="video/mp4,video/webm,video/ogg,video/quicktime"
              disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
            />
            {busy && <span className="spinner" />}
            {meta?.available && (
              <button className="danger" disabled={busy} onClick={remove} style={{ marginLeft: 'auto' }}>
                Remove video
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Subtab 3: customize keyboard shortcuts ─────────────────────────────────
type CatalogItem = { id: string; label: string; default: string; group: string };
type ShortcutsResp = { bindings: Record<string, string>; catalog: CatalogItem[] };

function ShortcutsSettings() {
  const toast = useToast();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['shortcuts'],
    queryFn: () => api.get<ShortcutsResp>('/api/auth/shortcuts'),
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (data?.bindings) setDraft({ ...data.bindings }); }, [data?.bindings]);

  const catalog = data?.catalog || [];
  const groups = useMemo(() => {
    const m = new Map<string, CatalogItem[]>();
    for (const c of catalog) { if (!m.has(c.group)) m.set(c.group, []); m.get(c.group)!.push(c); }
    return Array.from(m.entries());
  }, [catalog]);

  // key → list of action ids using it (to flag conflicts)
  const conflicts = useMemo(() => {
    const byKey = new Map<string, string[]>();
    for (const id in draft) {
      const k = draft[id];
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(id);
    }
    const bad = new Set<string>();
    for (const [, ids] of byKey) if (ids.length > 1) ids.forEach((i) => bad.add(i));
    return bad;
  }, [draft]);

  const dirty = useMemo(() => {
    if (!data?.bindings) return false;
    return catalog.some((c) => (draft[c.id] || '') !== (data.bindings[c.id] || ''));
  }, [draft, data?.bindings, catalog]);

  function setKey(id: string, raw: string) {
    const k = (raw || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(-1);
    setDraft((d) => ({ ...d, [id]: k }));
  }
  function resetDefaults() {
    const d: Record<string, string> = {};
    for (const c of catalog) d[c.id] = c.default;
    setDraft(d);
  }

  async function save() {
    // all must be filled and unique
    const missing = catalog.filter((c) => !draft[c.id]);
    if (missing.length) { toast(`Set a key for: ${missing.map((m) => m.label).join(', ')}`, 'error'); return; }
    if (conflicts.size) { toast('Two actions share a key — fix the highlighted ones.', 'error'); return; }
    setSaving(true);
    try {
      await api.put('/api/auth/shortcuts', { bindings: draft });
      toast('Shortcuts saved — they apply in the extension on your next page focus.', 'success');
      await refetch();
    } catch (e: any) {
      toast(e?.response?.data?.detail || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  return (
    <div>
      <div className="card" style={{ background: 'var(--panel-2)', fontSize: '0.86rem', marginBottom: '1rem' }}>
        Every shortcut is <strong>Alt + a key you choose</strong>. In the extension bar:
        <ul style={{ margin: '6px 0 0', lineHeight: 1.6 }}>
          <li><strong>Clicking</strong> a copy field <strong>copies</strong> it to the clipboard.</li>
          <li>Its <strong>shortcut pastes</strong> the value straight into whatever input you've clicked into on the page — including most embedded application forms.</li>
        </ul>
        Each key must be unique. Changes apply in the extension automatically (when its tab next gets focus).
        Shortcuts are <strong>Alt + key</strong> on every platform — on macOS hold <strong>Option</strong>.
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <div className="section-title" style={{ margin: 0 }}>Your shortcuts</div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="secondary" onClick={resetDefaults} disabled={saving}>Reset to defaults</button>
            <button onClick={save} disabled={saving || !dirty || conflicts.size > 0}>
              {saving ? <><span className="spinner" /> Saving…</> : 'Save shortcuts'}
            </button>
          </div>
        </div>

        {groups.map(([group, items]) => (
          <div key={group} style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em',
              color: 'var(--muted)', fontWeight: 700, marginBottom: 8,
            }}>{group}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
              {items.map((c) => {
                const bad = conflicts.has(c.id);
                return (
                  <div key={c.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    border: `1px solid ${bad ? 'var(--danger, #ef4444)' : 'var(--border)'}`,
                    borderRadius: 8, padding: '6px 10px',
                  }}>
                    <span style={{ flex: 1, fontSize: '0.86rem' }}>{c.label}</span>
                    <span className="muted" style={{ fontSize: '0.82rem' }}>Alt&nbsp;+</span>
                    <input
                      value={(draft[c.id] || '').toUpperCase()}
                      onChange={(e) => setKey(c.id, e.target.value)}
                      maxLength={1}
                      spellCheck={false}
                      style={{
                        width: 38, textAlign: 'center', textTransform: 'uppercase',
                        fontWeight: 700, padding: '4px', borderColor: bad ? 'var(--danger, #ef4444)' : undefined,
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {conflicts.size > 0 && (
          <div style={{ color: 'var(--danger, #ef4444)', fontSize: '0.84rem', marginTop: 4 }}>
            Some keys are used by more than one action (highlighted). Give each a unique key to save.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Exact, OS-specific auto-update setup ────────────────────────────────────
function AutoUpdateGuide({ extId }: { extId: string }) {
  const [os, setOs] = useState<'win' | 'mac' | 'linux'>(() => {
    const p = navigator.platform.toLowerCase();
    if (p.includes('win')) return 'win';
    if (p.includes('mac')) return 'mac';
    return 'linux';
  });
  const regUrl = `${BASE}/api/extension/policy.reg`;
  const jsonUrl = `${BASE}/api/extension/policy.json`;
  const updateUrl = `${BASE}/api/extension/update.xml`;
  const forceEntry = `${extId};${updateUrl}`;

  const codeBox: React.CSSProperties = {
    background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8,
    padding: '8px 10px', fontSize: '0.8rem', fontFamily: 'ui-monospace, monospace',
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '4px 0 10px',
  };
  const osBtn = (k: typeof os, label: string) => (
    <button onClick={() => setOs(k)} className={os === k ? '' : 'secondary'}
      style={{ borderRadius: 999, fontSize: '0.82rem' }}>{label}</button>
  );

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h2 style={{ marginTop: 0 }}>Auto-update setup — managed policy (one-time, needs admin)</h2>
      <div className="card" style={{ background: '#3a1a1a', border: '1px solid #a51f30', fontSize: '0.85rem', marginBottom: 12 }}>
        🛑 <strong>Requires an enterprise-managed Chrome.</strong> Chrome only force-installs a self-hosted (non-Web-Store)
        extension on machines that are <strong>domain-joined</strong> or enrolled in <strong>Chrome Browser Cloud
        Management</strong>. On a normal/personal PC this policy is <strong>blocked</strong> — at <code>chrome://policy</code>
        you'll see the value prefixed <code>[BLOCKED]</code> and a warning that the computer “is not detected as enterprise
        managed.” If you see that, this method won't work on that machine — use <strong>Manual install</strong> instead,
        or publish to the Chrome Web Store (ask the admin).
      </div>
      <div className="card" style={{ background: 'var(--panel-2)', fontSize: '0.82rem', marginBottom: 12 }}>
        ⚠️ A “Load unpacked” install <em>never</em> auto-updates — Chrome ignores the update
        URL for it. Auto-update <strong>only</strong> works through the policy below, which makes Chrome install its
        own managed copy from this server and keep it current.
        <div style={{ marginTop: 6 }}>
          <strong>If you already loaded it unpacked,</strong> remove that copy <strong>first</strong>:
          go to <code>chrome://extensions</code> → find “TailorResume Assistant” → <strong>Remove</strong>.
          Then do the policy steps below — the managed copy (same ID) will install and auto-update from now on.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {osBtn('win', '🪟 Windows')}
        {osBtn('mac', '🍎 macOS')}
        {osBtn('linux', '🐧 Linux')}
      </div>

      {os === 'win' && (
        <ol style={{ lineHeight: 1.8, fontSize: '0.9rem' }}>
          <li><a href={regUrl} download>Download <code>tailorresume_policy.reg</code></a>.</li>
          <li><strong>Double-click</strong> the downloaded <code>.reg</code> file.</li>
          <li>Click <strong>Yes</strong> on the “User Account Control” / “add to registry?” prompts.
            (You need a Windows admin account.)</li>
          <li><strong>Fully quit Chrome</strong> (close every window) and reopen it.</li>
          <li>Go to <code>chrome://policy</code> → click <strong>Reload policies</strong>. You should see
            <code> ExtensionInstallForcelist</code> listed with the value below.</li>
          <li>Open <code>chrome://extensions</code> — TailorResume Assistant appears, marked
            <strong> “Installed by enterprise policy.”</strong> Click its icon and <strong>sign in</strong>.</li>
        </ol>
      )}

      {os === 'mac' && (
        <ol style={{ lineHeight: 1.8, fontSize: '0.9rem' }}>
          <li>Open <strong>Terminal</strong> (Applications → Utilities).</li>
          <li>Paste this command and press Enter (it asks for your admin password):
            <div style={codeBox}>sudo defaults write com.google.Chrome ExtensionInstallForcelist -array "{forceEntry}"</div>
          </li>
          <li>Then run:
            <div style={codeBox}>sudo defaults write com.google.Chrome ExtensionInstallSources -array "{BASE}/*"</div>
          </li>
          <li><strong>Fully quit Chrome</strong> (Cmd-Q) and reopen it.</li>
          <li>Go to <code>chrome://policy</code> → <strong>Reload policies</strong> and confirm
            <code> ExtensionInstallForcelist</code> shows the value below.</li>
          <li>At <code>chrome://extensions</code> the extension appears “Installed by enterprise policy.”
            Click its icon and <strong>sign in</strong>.</li>
          <li className="muted" style={{ fontSize: '0.82rem' }}>
            On Macs managed by MDM, push a configuration profile for <code>com.google.Chrome</code> with the same
            <code> ExtensionInstallForcelist</code> value instead.
          </li>
        </ol>
      )}

      {os === 'linux' && (
        <ol style={{ lineHeight: 1.8, fontSize: '0.9rem' }}>
          <li>Create the policy folder (run in a terminal):
            <div style={codeBox}>sudo mkdir -p /etc/opt/chrome/policies/managed</div>
          </li>
          <li><a href={jsonUrl} download>Download <code>tailorresume_policy.json</code></a> and move it there:
            <div style={codeBox}>sudo mv ~/Downloads/tailorresume_policy.json /etc/opt/chrome/policies/managed/</div>
            (For Chromium use <code>/etc/chromium/policies/managed/</code> instead.)
          </li>
          <li>Make it readable:
            <div style={codeBox}>sudo chmod 644 /etc/opt/chrome/policies/managed/tailorresume_policy.json</div>
          </li>
          <li><strong>Fully quit Chrome</strong> and reopen it.</li>
          <li>Go to <code>chrome://policy</code> → <strong>Reload policies</strong> and confirm
            <code> ExtensionInstallForcelist</code> shows the value below.</li>
          <li>At <code>chrome://extensions</code> the extension appears “Installed by enterprise policy.”
            Click its icon and <strong>sign in</strong>.</li>
        </ol>
      )}

      <div style={{ marginTop: 8 }}>
        <div className="muted" style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          The exact policy value (for verifying at chrome://policy)
        </div>
        <div style={codeBox}>{forceEntry}</div>
      </div>

      <details style={{ fontSize: '0.85rem' }}>
        <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>It didn't install / didn't update — checklist</summary>
        <ul style={{ lineHeight: 1.7, marginTop: 8 }}>
          <li><strong>You must fully quit and relaunch Chrome</strong> — reloading a tab isn't enough.</li>
          <li>At <code>chrome://policy</code>, the <code>ExtensionInstallForcelist</code> row must show the value above.
            If it's missing, the file is in the wrong place or Chrome wasn't restarted.</li>
          <li>Windows: the <code>.reg</code> must be applied with an <strong>admin</strong> account, under
            <code> HKLM</code> (not HKCU).</li>
          <li>Updates aren't instant — Chrome checks the update URL on its own schedule (up to ~5 h). To force it now:
            <code> chrome://extensions</code> → Developer mode ON → <strong>Update</strong> button.</li>
          <li>Corporate/managed devices may already have a Chrome policy that blocks extra extensions — then your IT
            admin must add this one to the allowed list.</li>
        </ul>
      </details>
    </div>
  );
}
