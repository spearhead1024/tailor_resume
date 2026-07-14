/* Row-list merges for the board — pure, and deliberately IDEMPOTENT.
 *
 * Every row change reaches the author's screen twice, by two independent routes:
 *
 *   1. the HTTP response to their own POST/PATCH/DELETE, and
 *   2. the live socket, because the server broadcasts each change to everyone who may see the row —
 *      and the author is one of those people.
 *
 * The two race. The server fires the broadcast BEFORE it returns the response, so the socket
 * frequently wins. That is what made adding one row create two: the socket appended it, then the
 * POST resolved and appended the very same row a second time — same id, duplicate React key. Other
 * people only ever had route 2, so they correctly saw one row, which is what made it look like a
 * sync bug rather than a double-insert.
 *
 * Applying the same row twice must therefore be indistinguishable from applying it once. Merge by
 * id; never blind-append.
 */
export type MergeRow = { id: string; cells: Record<string, any> };

/** Add the row, or update it in place if it is already here. Never duplicates it. */
export function upsertRow<T extends MergeRow>(rows: T[], row: T): T[] {
  const i = rows.findIndex((r) => r.id === row.id);
  if (i < 0) return [...rows, row];
  const next = [...rows];
  next[i] = { ...next[i], ...row, cells: { ...row.cells } };
  return next;
}

/** Re-insert a row at a remembered position (undo of a delete). If the socket has already put it
 *  back, keep the one that is there rather than adding a second copy — position is a nicety, a
 *  duplicate row is a bug. */
export function insertRowAt<T extends MergeRow>(rows: T[], row: T, at: number): T[] {
  if (rows.some((r) => r.id === row.id)) return upsertRow(rows, row);
  const next = [...rows];
  next.splice(Math.max(0, Math.min(at, next.length)), 0, row);
  return next;
}

/** Remove a row. Removing one that has already gone is a no-op, not an error. */
export function removeRow<T extends MergeRow>(rows: T[], id: string): T[] {
  return rows.filter((r) => r.id !== id);
}
