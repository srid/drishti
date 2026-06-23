import type { Pid, Process, ProcessesSnapshotMsg } from "drishti-common";

/**
 * Fold one `processesSnapshot` frame into the accumulated process map.
 *
 * The stream is snapshot-then-delta — **delta-accumulate, not value-bearing**:
 * each frame is a *change*, not the full state, so the consumer must
 * accumulate. A `snapshot` frame replaces the whole map; a `delta` frame
 * applies its upserts/removes onto a copy of the previous map.
 *
 * Used as `createSubscription`'s `reduce`, so every frame is folded in the
 * subscription's own `for await` loop (no frame can be coalesced away) and the
 * accumulated map becomes a value-bearing reactive value the table renders
 * **fine-grained** — a row reads `processes()[pid].cpuPct`, so an in-place
 * `reconcile` leaf update re-notifies that one cell. Reading the whole map
 * coarsely and copying it into a separate store would instead drop a
 * same-shape delta (a leaf ticking under an unchanged key set never re-fires a
 * coarse reader) — the bug this fold's call site was rewritten to avoid.
 *
 * Kept here (not inline at the call site) so the reduction has a single home
 * and the hermetic test drives the exact production fold.
 */
export function foldProcessesMessage(
  acc: Record<Pid, Process>,
  msg: ProcessesSnapshotMsg,
): Record<Pid, Process> {
  if (msg.kind === "snapshot") {
    const next: Record<Pid, Process> = {};
    for (const [pid, value] of msg.entries) next[pid] = value;
    return next;
  }
  const next = { ...acc };
  for (const [pid, value] of msg.upserts) next[pid] = value;
  for (const pid of msg.removes) delete next[pid];
  return next;
}
