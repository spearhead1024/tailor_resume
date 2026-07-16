/* Small pill showing which server a row came from.
 *
 * The Profiles / Users / Applied tabs merge this instance's own rows (VPS_2) with read-only rows
 * fetched live from VPS_1 (the Resume-Generator-v2 box). This badge makes the origin obvious so a
 * VPS_1 row's greyed-out, non-editable controls read as intentional rather than broken. */
export default function SourceBadge({ source }: { source?: string }) {
  const remote = source === 'VPS_1';
  return (
    <span
      className="src-badge"
      title={remote ? 'Lives on VPS_1 — shown here read-only' : 'This server'}
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        color: remote ? '#a855f7' : '#22c55e',
        border: `1px solid ${remote ? '#a855f7' : '#22c55e'}`,
        background: remote ? 'rgba(168,85,247,0.10)' : 'rgba(34,197,94,0.10)',
      }}
    >
      {source || 'VPS_2'}
    </span>
  );
}
