import { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { etDateTime } from '../lib/etTime';

type Shot = {
  id: string;
  profile_id: string;
  profile_name: string;
  job_id: string;
  company: string;
  job_title: string;
  url: string;
  file: string;
  content_type: string;
  bytes: number;
  created_at: string;
  created_by_user_id: string;
  created_by_username: string;
};

// An <img> tag can't send the bearer token, so each image is fetched as an
// authed blob and shared via a module-level cache (so the filmstrip thumbnail
// and the large viewer never fetch the same screenshot twice).
const urlCache = new Map<string, string>();
function useShotUrl(id: string | null): string {
  const [src, setSrc] = useState<string>(() => (id && urlCache.get(id)) || '');
  useEffect(() => {
    if (!id) { setSrc(''); return; }
    const cached = urlCache.get(id);
    if (cached) { setSrc(cached); return; }
    let alive = true;
    api.raw
      .get(`/api/screenshots/${id}/image`, { responseType: 'blob' })
      .then((res) => {
        const url = URL.createObjectURL(res.data as Blob);
        urlCache.set(id, url);
        if (alive) setSrc(url);
      })
      .catch(() => { if (alive) setSrc(''); });
    return () => { alive = false; };
  }, [id]);
  return src;
}

function Thumb({ shot, active, onClick }: { shot: Shot; active: boolean; onClick: () => void }) {
  const src = useShotUrl(shot.id);
  return (
    <button
      onClick={onClick}
      title={`${shot.company || '—'}${shot.job_title ? ' · ' + shot.job_title : ''}`}
      style={{
        flex: '0 0 auto', width: 116, height: 74, padding: 0, borderRadius: 6, overflow: 'hidden',
        border: active ? '2px solid var(--accent, #38bdf8)' : '2px solid transparent',
        background: 'var(--panel-2)', cursor: 'pointer', position: 'relative',
        outline: active ? '0' : '1px solid var(--border)',
      }}>
      {src
        ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top', display: 'block' }} />
        : <span className="spinner" style={{ position: 'absolute', inset: 0, margin: 'auto' }} />}
    </button>
  );
}

export default function Screenshots() {
  const navigate = useNavigate();

  const [profileId, setProfileId] = useState('');
  const [bidder, setBidder] = useState('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selected, setSelected] = useState(0);
  const [zoom, setZoom] = useState(false); // true = fit-width (scroll), false = fit-screen

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isFetching } = useQuery({
    queryKey: ['screenshots'],
    queryFn: () => api.get<Shot[]>('/api/screenshots'),
  });
  const all = useMemo(() => data || [], [data]);

  const profiles = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of all) if (s.profile_id) m.set(s.profile_id, s.profile_name || s.profile_id);
    return Array.from(m.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);
  const bidders = useMemo(() => {
    const set = new Set<string>();
    for (const s of all) if (s.created_by_username) set.add(s.created_by_username);
    return Array.from(set).sort();
  }, [all]);

  const shots = useMemo(() => {
    return all.filter((s) => {
      if (profileId && s.profile_id !== profileId) return false;
      if (bidder && s.created_by_username !== bidder) return false;
      if (dateFrom && (s.created_at || '') < dateFrom) return false;
      if (dateTo && (s.created_at || '') > dateTo + 'T23:59:59Z') return false;
      if (debounced) {
        const hay = `${s.company} ${s.job_title} ${s.url} ${s.created_by_username} ${s.profile_name}`.toLowerCase();
        if (!hay.includes(debounced)) return false;
      }
      return true;
    });
  }, [all, profileId, bidder, dateFrom, dateTo, debounced]);

  // Keep the selection valid as filters change.
  useEffect(() => { setSelected(0); }, [profileId, bidder, dateFrom, dateTo, debounced]);
  const safeIndex = Math.min(selected, Math.max(0, shots.length - 1));
  const current: Shot | undefined = shots[safeIndex];
  const mainSrc = useShotUrl(current?.id ?? null);

  const go = useCallback((delta: number) => {
    setSelected((i) => {
      const n = shots.length;
      if (n === 0) return 0;
      return ((i + delta) % n + n) % n;
    });
  }, [shots.length]);

  // Keyboard navigation, photo-viewer style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  function clearFilters() { setQuery(''); setProfileId(''); setBidder(''); setDateFrom(''); setDateTo(''); }
  const hasFilters = !!(query || profileId || bidder || dateFrom || dateTo);

  async function openFull(id: string) {
    const res = await api.raw.get(`/api/screenshots/${id}/image`, { responseType: 'blob' });
    window.open(URL.createObjectURL(res.data as Blob), '_blank');
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>Screenshots</h1>
        {isFetching && <span className="spinner" />}
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          {shots.length ? `${safeIndex + 1} / ${shots.length}` : '0'}{all.length !== shots.length ? ` (of ${all.length})` : ''}
        </span>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Search company, title, URL, profile, bidder…" value={query}
          onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 340 }} />
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All profiles</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={bidder} onChange={(e) => setBidder(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="">All bidders</option>
          {bidders.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ maxWidth: 150 }} title="From" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ maxWidth: 150 }} title="To" />
        {hasFilters && <button className="secondary" onClick={clearFilters} style={{ fontSize: '0.82rem' }}>Clear</button>}
      </div>

      {!current ? (
        <div className="card"><span className="muted">No screenshots match the filters.</span></div>
      ) : (
        <div style={{
          border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden',
          background: 'var(--panel)', display: 'flex', flexDirection: 'column',
        }}>
          {/* Main viewer */}
          <div style={{
            position: 'relative', background: '#0b1120', height: '62vh', minHeight: 360,
            display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto',
          }}>
            {/* Prev / Next */}
            <button onClick={() => go(-1)} aria-label="Previous" style={navBtnStyle('left')} disabled={shots.length < 2}>‹</button>
            <button onClick={() => go(1)} aria-label="Next" style={navBtnStyle('right')} disabled={shots.length < 2}>›</button>

            {mainSrc ? (
              <img
                src={mainSrc}
                alt={current.company || current.url}
                onClick={() => setZoom((z) => !z)}
                title={zoom ? 'Click to fit screen' : 'Click to fit width (full length)'}
                style={zoom
                  ? { width: '100%', height: 'auto', display: 'block', cursor: 'zoom-out' }
                  : { maxWidth: '100%', maxHeight: '62vh', objectFit: 'contain', display: 'block', cursor: 'zoom-in' }}
              />
            ) : <span className="spinner" />}
          </div>

          {/* Caption / actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {current.company || '—'}{current.job_title ? ` · ${current.job_title}` : ''}
              </div>
              <div className="muted" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {current.profile_name || current.profile_id || '—'} · {current.created_by_username || '—'} · {etDateTime(current.created_at)}
                {current.url && <> · <a href={current.url} target="_blank" rel="noreferrer">{current.url}</a></>}
              </div>
            </div>
            <button className="secondary" style={{ fontSize: '0.82rem' }} onClick={() => openFull(current.id)}>↗ Full size</button>
            {current.company && (
              <button className="secondary" style={{ fontSize: '0.82rem' }} title="Find this job in the Jobs tab"
                onClick={() => navigate(`/jobs?company=${encodeURIComponent(current.company)}`)}>Job</button>
            )}
          </div>

          {/* Filmstrip */}
          <div style={{
            display: 'flex', gap: 8, padding: '10px 12px', overflowX: 'auto',
            borderTop: '1px solid var(--border)', background: 'var(--panel-2)',
          }}>
            {shots.map((s, i) => (
              <Thumb key={s.id} shot={s} active={i === safeIndex} onClick={() => setSelected(i)} />
            ))}
          </div>
        </div>
      )}

      <p className="muted" style={{ fontSize: '0.78rem', marginTop: 8 }}>
        Use ← → to flip through screenshots. Click the image to toggle fit-screen / full-length.
      </p>
    </div>
  );
}

function navBtnStyle(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)', [side]: 10,
    zIndex: 2, width: 40, height: 40, borderRadius: '50%', border: 'none',
    background: 'rgba(15,23,42,0.7)', color: '#fff', fontSize: 26, lineHeight: '1',
    cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0,
  } as React.CSSProperties;
}
