import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export default function Settings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<any>('/api/settings') });
  const [draft, setDraft] = useState('');

  useEffect(() => { if (data) setDraft(JSON.stringify(data, null, 2)); }, [data]);

  const saveMutation = useMutation({
    mutationFn: (payload: any) => api.put('/api/settings', { payload }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (isLoading) return <div><span className="spinner" /> Loading…</div>;

  function handleSave() {
    try {
      const parsed = JSON.parse(draft);
      saveMutation.mutate(parsed);
    } catch (e: any) {
      alert('Invalid JSON: ' + e.message);
    }
  }

  return (
    <div>
      <h1>Settings</h1>
      <p className="muted">App-level settings (admin only). Stored as JSON.</p>
      <div className="card">
        <textarea rows={28} value={draft} onChange={(e) => setDraft(e.target.value)}
          style={{ fontFamily: 'monospace', fontSize: '0.85rem' }} />
        <button style={{ marginTop: 10 }} onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? <span className="spinner" /> : 'Save settings'}
        </button>
      </div>
    </div>
  );
}
