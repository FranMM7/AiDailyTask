/**
 * Tracks writes this tab currently has in flight, per task.
 *
 * The server publishes `task.updated` the moment it finishes writing, which
 * routinely reaches the browser BEFORE the HTTP response to the request that
 * caused it — they land within a millisecond of each other. The rev guard in
 * SseProvider then reads a cache that the mutation's onSuccess has not updated
 * yet, concludes the change came from somewhere else, and invalidates the whole
 * board. On a 229-task board that is a ~600 ms re-read of every task file, for
 * one appended note.
 *
 * Knowing a write is in flight closes that window. It is safe to ignore the echo
 * because the mutation's own response carries the resulting task, and because
 * optimistic concurrency guarantees nobody else wrote between our read and our
 * write — if they had, the request would have come back 409 instead.
 *
 * A change made by someone else DURING our write would still arrive as an echo
 * we suppress, so `endTaskWrite` reports the revs it swallowed and the caller
 * reconciles anything that is not the rev it ended up with.
 */
interface PendingWrite {
  writes: number;
  /** Revs whose echo was suppressed while this task had a write in flight. */
  suppressed: number[];
}

const pending = new Map<string, PendingWrite>();

export function beginTaskWrite(id: string): void {
  const entry = pending.get(id);
  if (entry) entry.writes += 1;
  else pending.set(id, { writes: 1, suppressed: [] });
}

/**
 * Mark one in-flight write finished. Returns the revs whose echo was suppressed
 * while it ran, so the caller can tell "that was us" from "someone else wrote
 * too". Returns nothing while other writes on the same task are still running.
 */
export function endTaskWrite(id: string): number[] {
  const entry = pending.get(id);
  if (!entry) return [];
  entry.writes -= 1;
  if (entry.writes > 0) return [];
  pending.delete(id);
  return entry.suppressed;
}

/**
 * Called from the SSE handler. Records the rev and returns true when the event
 * is this tab's own echo and should not trigger a refetch.
 */
export function suppressOwnEcho(id: string, rev: number): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.suppressed.push(rev);
  return true;
}
