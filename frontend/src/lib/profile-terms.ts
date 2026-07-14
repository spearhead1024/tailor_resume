/* How a profile's engagement terms read as text. Shared by the Profiles page (which edits them) and
   the board's profile card (which shows them), so the two can never word the same fact differently. */

/* B2B is the EU vehicle and is always registered somewhere, so it carries a country. C2C is the US
   equivalent and never does. Freelancer is neither. */
export const CONTRACTS: { id: string; label: string }[] = [
  { id: 'b2b', label: 'B2B (EU)' },
  { id: 'c2c', label: 'C2C (US)' },
  { id: 'freelancer', label: 'Freelancer' },
];
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'RON', 'BGN', 'PLN'];
export const PERIODS = ['hour', 'day', 'month', 'year'];

export type ExpectedSalary = { min?: number; max?: number; currency?: string; period?: string };

/** "70–85 USD / hour", or '' when nothing is set — an unset range must not read as "0–0". */
export function salaryText(s: ExpectedSalary | undefined | null): string {
  const lo = Number(s?.min || 0), hi = Number(s?.max || 0);
  if (!lo && !hi) return '';
  const range = lo && hi ? `${lo.toLocaleString()}–${hi.toLocaleString()}` : (lo || hi).toLocaleString();
  return `${range} ${s?.currency || 'USD'} / ${s?.period || 'year'}`;
}

/** "B2B (Romania), Freelancer". Only B2B names its country. */
export function contractText(types: string[] | undefined | null, country?: string): string {
  return (types || [])
    .map((t) => (t === 'b2b' ? `B2B${country ? ` (${country})` : ''}` : t === 'c2c' ? 'C2C' : 'Freelancer'))
    .join(', ');
}
