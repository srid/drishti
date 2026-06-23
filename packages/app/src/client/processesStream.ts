import { batch } from "solid-js";
import { reconcile, type SetStoreFunction } from "solid-js/store";
import type { Pid, Process, ProcessesSnapshotMsg } from "drishti-common";

/**
 * Fold one `processesSnapshot` frame into the live process store.
 *
 * The stream is snapshot-then-delta, not value-bearing, so the consumer has
 * to accumulate. A `snapshot` frame `reconcile`s the whole map — the
 * structural diff keeps row identity stable so `<For>` reuses DOM instead of
 * churning every row. A `delta` frame applies its upserts/removes inside a
 * single `batch` so each dependent memo and the `<For>` reconciler fire once
 * per tick, not once per PID (a 470-PID tick would otherwise re-run every
 * dependent up to 470 times, shuffling `<tr>` nodes through intermediate
 * orderings before settling).
 *
 * `onRemoved` fires for each removed PID so the caller can drop a selection
 * pointing at a now-gone process. Lives here (rather than inline in
 * `<HostView>`'s `.streams.processesSnapshot.use()` effect) so the fold has a
 * single home and the hermetic test drives the exact production reduction.
 */
export function applyProcessesMessage(
  msg: ProcessesSnapshotMsg,
  setProcesses: SetStoreFunction<Record<Pid, Process>>,
  onRemoved: (pid: Pid) => void,
): void {
  if (msg.kind === "snapshot") {
    const next: Record<Pid, Process> = {};
    for (const [pid, value] of msg.entries) next[pid] = value;
    setProcesses(reconcile(next));
    return;
  }
  batch(() => {
    for (const [pid, value] of msg.upserts) setProcesses(pid, value);
    for (const pid of msg.removes) {
      setProcesses(pid, undefined!);
      onRemoved(pid);
    }
  });
}
