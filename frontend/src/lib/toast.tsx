import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

type ToastKind = 'success' | 'error' | 'info';
type Toast = { id: number; message: string; kind: ToastKind };

type ToastCtx = (message: string, kind?: ToastKind) => void;

const ToastContext = createContext<ToastCtx>(() => {});

let _nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const t = timers.current.get(id);
    if (t) { window.clearTimeout(t); timers.current.delete(id); }
  }, []);

  const push: ToastCtx = useCallback((message, kind = 'success') => {
    const id = _nextId++;
    setToasts((prev) => [...prev, { id, message, kind }]);
    const t = window.setTimeout(() => dismiss(id), 1800);
    timers.current.set(id, t);
  }, [dismiss]);

  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div style={{
        position: 'fixed',
        top: 70,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
      }}>
        {toasts.map((t) => (
          <div key={t.id}
            onClick={() => dismiss(t.id)}
            style={{
              pointerEvents: 'auto',
              cursor: 'pointer',
              background: t.kind === 'success' ? 'var(--success-bg)' : t.kind === 'error' ? 'var(--danger-bg)' : 'var(--accent-glow)',
              border: `1px solid ${t.kind === 'success' ? 'var(--success)' : t.kind === 'error' ? 'var(--danger)' : 'var(--accent)'}`,
              color: t.kind === 'success' ? '#6ee7b7' : t.kind === 'error' ? '#fca5a5' : '#93c5fd',
              borderRadius: 999,
              padding: '0.5rem 1.1rem',
              fontSize: '0.88rem',
              fontWeight: 500,
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              animation: 'toastIn 0.2s ease-out',
            }}>
            {t.kind === 'success' && '✓ '}
            {t.kind === 'error' && '✗ '}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastCtx {
  return useContext(ToastContext);
}
