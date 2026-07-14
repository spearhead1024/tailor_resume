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
    // 1.8s was too short to actually read a notification ("X assigned you Y"). Click to dismiss early.
    const t = window.setTimeout(() => dismiss(id), 5000);
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
        {toasts.map((t) => {
          const accent = t.kind === 'success' ? 'var(--success)' : t.kind === 'error' ? 'var(--danger)' : 'var(--accent)';
          return (
            <div key={t.id}
              onClick={() => dismiss(t.id)}
              style={{
                pointerEvents: 'auto',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                // OPAQUE. The old toast used a 12%-alpha tint, so whatever was behind it bled
                // through and the text became unreadable over a busy board. A solid panel with a
                // coloured accent bar keeps the kind obvious without sacrificing legibility.
                background: '#141a2b',
                border: '1px solid rgba(255,255,255,0.10)',
                borderLeft: `4px solid ${accent}`,
                color: 'var(--text)',
                borderRadius: 10,
                padding: '0.6rem 1rem',
                maxWidth: 'min(520px, 92vw)',
                fontSize: '0.88rem',
                fontWeight: 500,
                lineHeight: 1.45,
                boxShadow: '0 8px 28px rgba(0,0,0,0.55)',
                animation: 'toastIn 0.2s ease-out',
              }}>
              <span style={{ color: accent, fontWeight: 700, flex: '0 0 auto' }}>
                {t.kind === 'success' ? '✓' : t.kind === 'error' ? '✗' : 'ℹ'}
              </span>
              <span style={{ minWidth: 0 }}>{t.message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastCtx {
  return useContext(ToastContext);
}
