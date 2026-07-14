/* Column rules that must hold in EVERY renderer — the table's stacked cells, the table's plain cells,
   and the calendar's detail popup. They lived inside the stacked-cell renderer, which meant a column
   silently lost its rule the moment a layout change moved it out of a stack. */

type OptLike = { label: string };
type ColLike = { id: string; options?: OptLike[] };

/** The column as this ROW may use it.
 *
 *  Workflow rule (the server enforces it too — this only stops the UI offering a choice that would be
 *  refused): a call cannot be 'Confirmed' until somebody is assigned to make it. So drop that option
 *  while the row has no Caller, leaving Pending.
 *
 *  Reads the RAW c_caller, not the Caller cell's displayed value: a call handed to a team with nobody
 *  picked yet displays the team, but there is still no person on the hook, and the server agrees.
 *
 *  A legacy row that is somehow already Confirmed with no caller keeps the option — otherwise its
 *  pill would lose its colour and the value would look corrupt. */
export function effCol<T extends ColLike>(col: T, cells: Record<string, any> | undefined | null): T {
  if (col.id !== 'c_approved') return col;
  const hasCaller = !!String(cells?.c_caller ?? '').trim();
  const alreadyConfirmed = String(cells?.c_approved ?? '').trim() === 'Confirmed';
  if (hasCaller || alreadyConfirmed) return col;
  return { ...col, options: (col.options || []).filter((o) => o.label !== 'Confirmed') };
}
