/** "Easy" (LinkedIn Easy Apply — a LinkedIn job link, bid in the extension's Easy Bids) or "Out"
 *  (applies on the company's site — Out Bids). The server decides (core/easy_apply.is_easy_apply). */
export type ApplyType = 'easy' | 'out';

/** A small LinkedIn "in Easy Apply" badge — shown on Easy Apply jobs only (nothing for the others). */
export function ApplyBadge({ type }: { type?: string }) {
  if (type !== 'easy') return null;
  return (
    <span className="easy-badge" title="LinkedIn Easy Apply — bid in the extension's Easy Bids">
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#0a66c2" />
        <path fill="#fff" d="M4.1 6.3h1.8V12H4.1zM5 3.6a1 1 0 1 1 0 2.1 1 1 0 0 1 0-2.1zM7.1 6.3h1.7v.8c.3-.5.9-.9 1.8-.9 1.9 0 2.2 1.2 2.2 2.8V12h-1.8V9.3c0-.7 0-1.5-.9-1.5s-1.1.7-1.1 1.5V12H7.1z" /></svg>
      Easy Apply
    </span>
  );
}

/** The filter: '' = both. */
export function ApplyTypeSelect({ value, onChange, style }: { value: string; onChange: (v: string) => void; style?: React.CSSProperties }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={style} title="Easy Apply (LinkedIn) or Out (company site)">
      <option value="">Easy + Out</option>
      <option value="easy">Easy Apply</option>
      <option value="out">Out Apply</option>
    </select>
  );
}
