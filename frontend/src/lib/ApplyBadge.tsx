/** "Easy" (LinkedIn Easy Apply — a LinkedIn job link, bid in the extension's Easy Bids) or "Out"
 *  (applies on the company's site — Out Bids). The server decides (core/easy_apply.is_easy_apply). */
export type ApplyType = 'easy' | 'out';

export function ApplyBadge({ type }: { type?: string }) {
  const easy = type === 'easy';
  return (
    <span className={`pill apply-${easy ? 'easy' : 'out'}`}
      title={easy ? 'LinkedIn Easy Apply — bid in Easy Bids' : "Applies on the company's site — bid in Out Bids"}>
      {easy ? 'Easy' : 'Out'}
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
