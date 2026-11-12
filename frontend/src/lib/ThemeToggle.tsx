import { nextThemePref, ThemePref, useTheme } from './theme';

const LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/* 16px line icons in currentColor, so they take the nav's muted/hover colours like the links do. */
const ICON: Record<ThemePref, JSX.Element> = {
  system: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
    </svg>
  ),
  light: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
};

/** One nav button that cycles the theme preference System → Light → Dark. The icon shows the
 *  CURRENT preference; the tooltip names it (and what System resolves to) and the next step. */
export default function ThemeToggle() {
  const { pref, theme, setPref } = useTheme();
  const next = nextThemePref(pref);
  const now = pref === 'system' ? `System (${LABEL[theme].toLowerCase()})` : LABEL[pref];
  const title = `Theme: ${now} — click for ${LABEL[next]}`;
  return (
    <button type="button" className="ghost theme-toggle" onClick={() => setPref(next)}
      title={title} aria-label={title}>
      {ICON[pref]}
    </button>
  );
}
