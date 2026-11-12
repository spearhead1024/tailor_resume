/* Light / dark theming.
 *
 * The user picks a PREFERENCE — 'system' (default), 'light' or 'dark' — stored in localStorage. It is
 * RESOLVED to a concrete theme and written to <html data-theme="light|dark">; every colour in
 * styles.css is a custom property keyed off that attribute. index.html runs an inline copy of the
 * resolve step before the first paint, so the page never flashes the wrong theme; this module takes
 * over once React is up (live system changes, the nav toggle, other tabs).
 *
 * Keep STORAGE_KEY and the theme-color values in sync with the inline script in index.html. */
import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const STORAGE_KEY = 'tailorresume.theme';
export const THEME_PREFS: ThemePref[] = ['system', 'light', 'dark'];
/* Mobile browser chrome tint, per resolved theme: dark keeps the original brand navy, light matches
   the light top nav. */
const THEME_COLOR: Record<Theme, string> = { dark: '#16307d', light: '#ffffff' };

const isPref = (v: unknown): v is ThemePref => v === 'system' || v === 'light' || v === 'dark';

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isPref(v) ? v : 'system';
  } catch { return 'system'; }    // storage blocked (private mode, sandboxed iframe)
}

function writePref(p: ThemePref) {
  try {
    if (p === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, p);
  } catch { /* storage blocked: the choice still applies for this page view */ }
}

/* Asks for LIGHT, so a browser with no preference (or no matchMedia) gets dark — the app's original look. */
const media = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: light)') : null;
const systemTheme = (): Theme => (media?.matches ? 'light' : 'dark');

let pref: ThemePref = readPref();
const listeners = new Set<() => void>();

export function resolveTheme(p: ThemePref = pref): Theme {
  return p === 'system' ? systemTheme() : p;
}

/** Write the resolved theme to the document: data-theme, color-scheme, and <meta name="theme-color">. */
function apply() {
  if (typeof document === 'undefined') return;
  const t = resolveTheme();
  const root = document.documentElement;
  root.dataset.theme = t;
  root.style.colorScheme = t;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLOR[t];
}

function emit() {
  apply();
  listeners.forEach((l) => l());
}

export function setThemePref(p: ThemePref) {
  pref = p;
  writePref(p);
  emit();
}

/** Next preference in the toggle's cycle: System → Light → Dark → System. */
export const nextThemePref = (p: ThemePref): ThemePref => THEME_PREFS[(THEME_PREFS.indexOf(p) + 1) % THEME_PREFS.length];

// Live updates: the OS switching light/dark (only matters while the preference is 'system'), and the
// preference being changed in another tab.
media?.addEventListener?.('change', () => { if (pref === 'system') emit(); });
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    const p = readPref();
    if (p !== pref) { pref = p; emit(); }
  });
}
apply();   // idempotent with the inline script; also covers a missing/blocked inline script

// useSyncExternalStore needs a stable snapshot; encode both values in one string.
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => `${pref}:${resolveTheme()}`;

/** The current preference and the theme it resolves to, re-rendering on any change. */
export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void } {
  const snap = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [p, t] = snap.split(':') as [ThemePref, Theme];
  return { pref: p, theme: t, setPref: setThemePref };
}

