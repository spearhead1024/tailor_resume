import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import ToDoBidder from './ToDoBidder';

const PROFILE_STORAGE_KEY = 'apply.selected_profile_id';

type Profile = {
  id: string;
  name: string;
  status?: 'active' | 'restricted';
  pending_count?: number;
  [k: string]: any;
};

export default function Apply() {
  const [profileId, setProfileId] = useState<string>(() => localStorage.getItem(PROFILE_STORAGE_KEY) || '');

  const { data: meta, isLoading } = useQuery({
    queryKey: ['apply', 'meta'],
    queryFn: () => api.get<{ role: string; profiles: Profile[] }>('/api/todo'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const profiles: Profile[] = meta?.profiles || [];

  useEffect(() => {
    if (profileId) localStorage.setItem(PROFILE_STORAGE_KEY, profileId);
  }, [profileId]);

  useEffect(() => {
    if (profiles.length === 0) return;
    const current = profiles.find((p) => p.id === profileId);
    const restrictedSelected = current?.status === 'restricted';
    if (!current || restrictedSelected) {
      const firstActive = profiles.find((p) => p.status !== 'restricted');
      setProfileId((firstActive || profiles[0]).id);
    }
  }, [profiles, profileId]);

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  if (profiles.length === 0) {
    return (
      <div>
        <h1>Apply</h1>
        <div className="card">
          <span className="muted">No accessible profiles. Ask an admin to assign one to your account.</span>
        </div>
      </div>
    );
  }

  const profile = profiles.find((p) => p.id === profileId);
  const selectedRestricted = profile?.status === 'restricted';
  const totalPending = profiles.reduce((sum, p) => sum + (p.pending_count || 0), 0);

  function describe(p: Profile) {
    const status = p.status === 'restricted' ? 'Restricted' : 'Active';
    if (typeof p.pending_count === 'number') {
      return `${p.name} · ${status} · ${p.pending_count} to apply`;
    }
    return `${p.name} · ${status}`;
  }

  return (
    <div>
      <h1>Apply</h1>

      <div className="card" style={{
        marginBottom: '1.25rem', display: 'flex', alignItems: 'center',
        gap: 12, padding: '0.85rem 1.1rem', flexWrap: 'wrap',
      }}>
        <label style={{ margin: 0, fontSize: '0.78rem', whiteSpace: 'nowrap' }}>Profile</label>
        <select
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          style={{ width: 'auto', flex: '0 1 380px', minWidth: 220 }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id} disabled={p.status === 'restricted'}>
              {describe(p)}{p.status === 'restricted' ? ' (restricted)' : ''}
            </option>
          ))}
        </select>

        {profile && (
          <span className={`pill ${selectedRestricted ? 'rejected' : 'approved'}`}>
            {(profile.status || 'active').toUpperCase()}
          </span>
        )}

        <span style={{
          fontSize: '0.82rem', color: 'var(--muted)',
          paddingLeft: 8, borderLeft: '1px solid var(--border)',
        }}>
          Total to apply across all profiles:{' '}
          <strong style={{ color: 'var(--text)' }}>{totalPending}</strong>
        </span>
      </div>

      {selectedRestricted ? (
        <div className="card">
          <span className="muted">This profile is <strong>restricted</strong> — select an active profile to continue.</span>
        </div>
      ) : profileId && profile ? (
        <ToDoBidder profileId={profileId} profile={profile} />
      ) : null}
    </div>
  );
}
