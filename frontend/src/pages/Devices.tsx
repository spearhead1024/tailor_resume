import { useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../lib/toast';

type Device = {
  id: string;
  user_id: string;
  username: string;
  full_name: string;
  is_admin: boolean;
  fingerprint: string;
  user_agent: string;
  browser: string;
  os: string;
  device_type: string;
  ip: string;
  login_count: number;
  first_seen: string;
  last_seen: string;
  revoked: boolean;
  revoked_at: string;
};

function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function deviceIcon(type: string): string {
  if (type === 'mobile')  return '📱';
  if (type === 'tablet')  return '📲';
  if (type === 'bot')     return '🤖';
  if (type === 'desktop') return '🖥️';
  return '💻';
}

export default function Devices() {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<'all' | 'active' | 'revoked'>('active');
  const [userFilter, setUserFilter] = useState<string>('');

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<Device[]>('/api/devices'),
    refetchInterval: 30_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (sid: string) => api.post(`/api/devices/${sid}/revoke`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['devices'] }); toast('Session revoked', 'success'); },
    onError: () => toast('Failed to revoke', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (sid: string) => api.delete(`/api/devices/${sid}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['devices'] }); toast('Session deleted', 'success'); },
    onError: () => toast('Failed to delete', 'error'),
  });

  const usernames = useMemo(() => {
    const set = new Set<string>();
    devices.forEach((d) => d.username && set.add(d.username));
    return Array.from(set).sort();
  }, [devices]);

  const filtered = useMemo(() => {
    return devices.filter((d) => {
      if (filter === 'active'  && d.revoked)  return false;
      if (filter === 'revoked' && !d.revoked) return false;
      if (userFilter && d.username !== userFilter) return false;
      return true;
    });
  }, [devices, filter, userFilter]);

  const counts = useMemo(() => ({
    all: devices.length,
    active: devices.filter((d) => !d.revoked).length,
    revoked: devices.filter((d) =>  d.revoked).length,
  }), [devices]);

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem', gap: '1rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Devices</h1>
        <div style={{ flex: 1 }} />
        <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">All users</option>
          {usernames.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        {(['active', 'revoked', 'all'] as const).map((k) => (
          <button key={k}
            className={filter === k ? '' : 'secondary'}
            onClick={() => setFilter(k)}>
            {k.charAt(0).toUpperCase() + k.slice(1)} · {counts[k]}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="card"><span className="muted">No sessions match the current filters.</span></div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Device</th>
                <th>Browser / OS</th>
                <th>IP</th>
                <th style={{ textAlign: 'center' }}>Logins</th>
                <th style={{ whiteSpace: 'nowrap' }}>First seen</th>
                <th style={{ whiteSpace: 'nowrap' }}>Last seen</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} style={{ opacity: d.revoked ? 0.55 : 1 }}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{d.username || d.user_id}</div>
                    {d.full_name && <div className="muted" style={{ fontSize: '0.78rem' }}>{d.full_name}</div>}
                    {d.is_admin && <span className="pill approved" style={{ fontSize: '0.66rem', marginTop: 2 }}>ADMIN</span>}
                  </td>
                  <td>
                    <span title={d.device_type}>{deviceIcon(d.device_type)}</span>{' '}
                    <span className="muted" style={{ fontSize: '0.82rem' }}>{d.device_type}</span>
                  </td>
                  <td>
                    <div>{d.browser || '—'}</div>
                    <div className="muted" style={{ fontSize: '0.78rem' }}>{d.os || '—'}</div>
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>{d.ip || '—'}</td>
                  <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{d.login_count}</td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: '0.82rem' }}>{formatDateTime(d.first_seen)}</td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: '0.82rem' }}>{formatDateTime(d.last_seen)}</td>
                  <td>
                    <span className={`pill ${d.revoked ? 'rejected' : 'approved'}`}>
                      {d.revoked ? 'REVOKED' : 'ACTIVE'}
                    </span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!d.revoked && (
                      <button className="secondary" style={{ marginRight: 4 }}
                        onClick={() => {
                          if (confirm(`Revoke this session for ${d.username}? They will need to sign in again.`))
                            revokeMutation.mutate(d.id);
                        }}>
                        Revoke
                      </button>
                    )}
                    <button className="danger"
                      onClick={() => {
                        if (confirm('Delete this device record entirely?'))
                          deleteMutation.mutate(d.id);
                      }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
