// [CODE] "Never silently retracted" — arch §14.0b, for every surface.
//
// A live trigger on a still-open session publishes immediately and marks what
// it published as provisional. §14.0b rule 3 then says the honest part out
// loud: such an item MAY change or disappear as the conversation resolves
// ("dinner tonight?" → "let's skip it").
//
// A list that simply re-renders whatever the latest poll returned satisfies
// rule 3 by accident and violates its spirit exactly: the row is gone, the
// reader never learns it was ever there, and the surface has quietly rewritten
// history. So a provisional row that vanishes between polls is KEPT, struck
// through, and labelled — until the reader dismisses it.
//
// A settled row is not retained. Its disappearance is a filter or a scope
// change, not a retraction, and mourning it would be noise.

export interface Identified {
  id: string;
}

/** A row plus what the list knows about its fate. */
export interface Retained<T extends Identified> {
  row: T;
  /** The row was provisional and is no longer in the worker's answer. */
  retracted: boolean;
}

/**
 * Fold a fresh poll into the list the reader is looking at.
 *
 * Present rows take the fresh copy and the fresh order — §14.0b rule 2, items
 * update in place rather than stacking. Absent-but-provisional rows keep their
 * LAST KNOWN content (the worker will not serve it again) and are appended,
 * marked retracted, in the order they were lost.
 */
export function retainProvisional<T extends Identified>(
  previous: readonly Retained<T>[],
  next: readonly T[],
  isProvisional: (row: T) => boolean,
): Retained<T>[] {
  const fresh = new Set(next.map((row) => row.id));
  const live: Retained<T>[] = next.map((row) => ({ row, retracted: false }));

  const lost = previous.filter(
    (entry) => !fresh.has(entry.row.id) && (entry.retracted || isProvisional(entry.row)),
  );

  // Already-retracted rows keep their retracted copy; newly-lost ones are
  // frozen at the last state the reader actually saw.
  return [...live, ...lost.map((entry) => ({ row: entry.row, retracted: true }))];
}

/** Drop one retracted row — the reader has read it and acknowledged it. */
export function dismissRetracted<T extends Identified>(
  list: readonly Retained<T>[],
  rowId: string,
): Retained<T>[] {
  return list.filter((entry) => !(entry.retracted && entry.row.id === rowId));
}

/** The rows that are actually present, for counting and for empty states. */
export function livingRows<T extends Identified>(list: readonly Retained<T>[]): T[] {
  return list.filter((entry) => !entry.retracted).map((entry) => entry.row);
}
