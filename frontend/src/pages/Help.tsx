import { useState, useEffect, useRef } from 'react';
import { useUrlState } from '../lib/urlState';
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
type Sub = 'extension' | 'guide';

export default function Help() {
  const [sub, setSub] = useUrlState<Sub>('tab', 'extension');   // in the URL — a refresh stays on this sub-tab

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
      </div>

      {sub === 'extension' && <ExtensionGuide />}
      {sub === 'guide' && <GuideVideo />}
    </div>
  );
}

// ─── Subtab 1: the extension — install once, it updates itself, how to use it ──
// Bidders install with the one-time Windows setup (backend routers/extension.py → a scheduled task
// that fetches new versions; the extension restarts into them — extension/lib/self-update.js).
function ExtensionGuide() {
  const { data, isLoading } = useQuery({
    queryKey: ['extension', 'version'],
    queryFn: () => api.get<ExtMeta>('/api/extension/version'),
  });
  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  const installer = `${BASE}/api/extension/install-windows.cmd`;
  const zipUrl = data?.zip_url || `${BASE}/api/extension/latest.zip`;
  const folder = '%LOCALAPPDATA%\\TailorResume\\extension';
  const step: React.CSSProperties = { lineHeight: 1.75, fontSize: '0.9rem', margin: '0.25rem 0 0', paddingLeft: '1.2rem' };
  const h2: React.CSSProperties = { margin: '0 0 0.5rem', fontSize: '1.05rem' };

  return (
    <div style={{ display: 'grid', gap: '1rem', maxWidth: 820 }}>
      {/* Version */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div className="muted" style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>TailorResume extension</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>v{data?.version || '—'}</div>
          {data?.changelog && <div style={{ fontSize: '0.86rem', marginTop: 4 }}><strong>New:</strong> {data.changelog}</div>}
          {data?.built_at && (
            <div className="muted" style={{ fontSize: '0.8rem', marginTop: 2 }}>
              Released {new Date(data.built_at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET
            </div>
          )}
        </div>
        <a href={installer} download><button>⬇ Download setup (Windows)</button></a>
      </div>

      {/* Install */}
      <div className="card">
        <h2 style={h2}>1 · Install — once per PC (2 min, no admin rights)</h2>
        <ol style={step}>
          <li>Download the setup above and <strong>double-click</strong> it. If Windows warns, click <strong>More info → Run anyway</strong>.
            It opens the extension folder <code>{folder}</code>.</li>
          <li>In Chrome open <code>chrome://extensions</code> and <strong>Remove</strong> any old TailorResume extension.</li>
          <li>Turn on <strong>Developer mode</strong> (top right) → <strong>Load unpacked</strong> → choose that folder.</li>
          <li>Pin the TailorResume icon, click it, and <strong>sign in</strong>.</li>
        </ol>
      </div>

      {/* Updates */}
      <div className="card">
        <h2 style={h2}>2 · Updates — automatic</h2>
        <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.6 }}>
          New versions install by themselves within a minute. In a hurry? Click <strong>Update Now</strong> in the panel
          (the green bar, or ⚙ Settings → Extension).
        </p>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.82rem' }}>
          Set up before v1.8.2? Run the setup once more — it switches to the faster check.
        </p>
      </div>

      {/* Use */}
      <div className="card">
        <h2 style={h2}>3 · Use it</h2>
        <ul style={{ ...step, listStyle: 'disc' }}>
          <li>The panel opens on the right tab by itself: <strong>Easy Bids</strong> on LinkedIn, <strong>Out Bids</strong> on an
            empty tab (the latest job opens there), <strong>Add Jobs</strong> on any other site.</li>
          <li><strong>⚙ Settings → Connections</strong>: connect <strong>ChatGPT</strong> (a paid plan — it writes the CVs)
            and <strong>LinkedIn</strong> (Easy Bids reads the job you have open). Pick a profile at the top of the panel.</li>
          <li><strong>Easy Bids</strong> — LinkedIn Easy Apply. Open a job on LinkedIn; the panel checks it first:
            <em> New Job</em>, <em>CV Ready</em>, <em>Duplicate</em> or <em>Applied</em>. Click <strong>Add + Gen CV</strong>:
            the CV is written (only that job — Easy Bids has no queue) and saved to Downloads as “Name Resume.pdf”. Apply on LinkedIn, then <strong>Mark as Applied</strong>.
            A posting that applies on the company's site gets <strong>Add Job</strong> only — it goes to Out Bids.</li>
          <li><strong>ChatGPT project — one per profile (do this once)</strong>. Everyone shares one ChatGPT account, and its
            memory mixes profiles up (Farhan's chat answering with Stefan's details). In ChatGPT: <strong>New project</strong> →
            name it after the profile → ⚙ <strong>Memory: Project-only</strong> → Create. With that project open, in the panel:
            ⚙ Settings → <strong>Project · &lt;profile&gt;</strong> → <strong>Use This Tab</strong>. It's saved for every bidder; that
            profile's CVs and answers are then written inside its project.</li>
          <li><strong>Out Bids</strong> — jobs that apply on the company's site. ChatGPT prepares <strong>2 jobs</strong>
            (shown under the job): the one on screen and the next one. You see <strong>one ChatGPT tab</strong>: the chat of
            the job on screen. The next job's CV is written out of sight, in a minimized ChatGPT window — when you move to
            that job, its chat comes into view. <strong>Download CV</strong>, apply, then <strong>Mark as Applied</strong> (or Report / Skip):
            its ChatGPT chat is deleted, the next one comes up, and the newest job in the queue joins. A job that already has a CV is never sent to ChatGPT again.
            Each job has its own chat; its questions are always answered there.</li>
          <li><strong>Tech Questions</strong> — paste the application's questions (one per line) and click
            <strong> Save &amp; Answer</strong>: ChatGPT answers them first, before any other CV, in the same chat that wrote the CV — with the
            fast <strong>Instant</strong> model, then it is set back so CVs keep their model (⚙ Settings → <strong>ChatGPT models</strong>).
            Every bidder on that job sees them; click <strong>Copy</strong> to use an answer.</li>
          <li><strong>Add Jobs</strong> (job adders) — open a job posting and add it in one click; duplicates are flagged.
            The <strong>AI check</strong> reads it in a few seconds: a clearly remote, paid software job goes live at once; an onsite /
            hybrid / clearance job, or one that doesn't say where the work is, waits in <strong>Jobs → Pending</strong> for an admin.
            If it is rejected, the reason shows under its status.</li>
          <li><strong>Tech stack</strong> — every job shows its main stack (React, Python…) in Jobs, Applied, the panel, and
            <strong> Schedule</strong> copies it into the Interviews board's Skillset.</li>
        </ul>
      </div>

      <details className="card" style={{ fontSize: '0.86rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Not on Windows, or something's wrong?</summary>
        <ul style={{ ...step, listStyle: 'disc', marginTop: 8 }}>
          <li><strong>Mac / Linux</strong>: <a href={zipUrl} download>download the .zip</a>, extract it, then
            <code> chrome://extensions</code> → Developer mode → <strong>Load unpacked</strong>. It doesn't update by itself:
            for a new version replace the folder's files and click ↻ on the extension.</li>
          <li><strong>A Save dialog pops up for every CV</strong>: turn off “Ask where to save each file before downloading”
            in <code>chrome://settings/downloads</code> (Edge: <code>edge://settings/downloads</code>) — CVs then save to Downloads by themselves.</li>
          <li><strong>Update didn't arrive</strong>: check <code>%LOCALAPPDATA%\TailorResume\updater.log</code>, or run the setup again.</li>
          <li><strong>Stop automatic updates</strong>: Windows Task Scheduler → delete “TailorResume extension updater”.</li>
        </ul>
      </details>
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
  const [vidFailed, setVidFailed] = useState(false);
  const [vidTry, setVidTry] = useState(0);

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
    setVidFailed(false);
    if (meta?.available) {
      setVidLoading(true);
      api.raw.get('/api/guide/video', { responseType: 'blob' })
        .then((res) => { if (!alive) return; url = URL.createObjectURL(res.data as Blob); setVideoUrl(url); })
        .catch(() => { if (alive) { setVideoUrl(''); setVidFailed(true); } })
        .finally(() => { if (alive) setVidLoading(false); });
    } else {
      setVideoUrl('');
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [meta?.available, v, vidTry]);

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
              {vidFailed && !vidLoading
                ? <>Couldn't load the video. <button className="secondary" onClick={() => setVidTry((n) => n + 1)}>Retry</button></>
                : <><span className="spinner" /> Loading video…</>}
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
