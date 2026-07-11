/**
 * The `alerts` domain — a pure threshold+hysteresis fold over host metrics.
 *
 * This module is AGENT-shared (drishti-common) and stays FRAMEWORK-FREE: it
 * carries only the wire schema (`AlertsSchema`), the value shapes, and the pure
 * fold (`applyHysteresis`) + its equality gate (`alertsEqual`). The reactor that
 * DRIVES this fold (`scan(metrics, NO_ALERTS, applyHysteresis)`) lives ONLY in
 * the agent's `main.ts` — importing `@kolu/surface/reactor` here would fold a
 * backend-only signals engine into the agent-shared graph, which the agent-boots
 * CI check forbids. So the graph is the agent's; the fold is everyone's.
 *
 * **Hysteresis, not a bare threshold.** A single cutoff at 80% would flap an
 * alert on and off every poll for a metric hovering at the line. Instead a metric
 * RAISES at `pct >= RAISE_PCT` (80) and only CLEARS once it falls below
 * `CLEAR_PCT` (70) — the dead band between the two is the "hold" region where an
 * already-raised alert stays raised and an un-raised one stays quiet. This is the
 * same Schmitt-trigger shape a thermostat uses.
 *
 * **The prev-reference hold is load-bearing.** When nothing crosses a threshold,
 * `applyHysteresis` returns the PREV `state` reference unchanged. The reactor's
 * `scan` reads that `===` as "no change" and publishes nothing — so a quiet tick
 * costs zero wire traffic. Returning a fresh-but-equal object would defeat that
 * gate; the cell's `equals` (`alertsEqual`) is the second line of defence for
 * values that differ by reference but not by content.
 */

import { z } from "zod";
import type { MetricKey } from "./metrics";

/** A host's raw metric percentages for one poll tick (0-100). The fold's input
 *  frame — one number per metric, keyed by the shared `MetricKey`, decoupled
 *  from the wider `system` cell so the alert graph steps on exactly the numbers
 *  it thresholds, nothing more. */
export type MetricsFrame = Record<MetricKey, number>;

/** The metrics an alert can fire for — the SAME vocabulary the history chart
 *  keys on (`MetricKey`, single-sourced in `drishti-common/metrics`). Stable
 *  ids: `watchByEntry`'s set-diff decides "same alert, not a new one" on these,
 *  so they must not churn. */
export type AlertId = MetricKey;

/** One raised alert: which metric. Nothing else — the human word is a
 *  client-owned presentation lookup (`LABELS` in the app), and no consumer
 *  reads a pct, so neither rides the wire. */
export interface AlertItem {
  id: AlertId;
}

/** The set of currently-raised alerts for one host. */
export interface Alerts {
  items: AlertItem[];
}

export const AlertsSchema = z.object({
  items: z.array(
    z.object({
      id: z.enum(["cpu", "mem", "disk"]),
    }),
  ),
});

/** The empty alert set — the fold's seed and the cell's gate-closed default. A
 *  fresh process re-derives its alerts from fresh samples (the fold carries no
 *  durable state), so booting with "nothing raised" is the honest start. */
export const NO_ALERTS: Alerts = { items: [] };

/** Raise once a metric reaches this percentage (0-100). */
const RAISE_PCT = 80;
/** Clear only once a metric falls below this — the lower edge of the dead band
 *  that stops a hovering metric from flapping. */
const CLEAR_PCT = 70;

/** The metrics folded, in a fixed order, so `applyHysteresis` iterates one list
 *  rather than three hand-copied blocks. */
const METRIC_IDS: readonly AlertId[] = ["cpu", "mem", "disk"];

/**
 * Threshold+hysteresis fold: step the raised-alert set forward by one metric
 * frame.
 *
 * Per metric: RAISE (add the item) when it crosses up to `RAISE_PCT` while not
 * already raised; CLEAR (remove it) when it falls below `CLEAR_PCT` while raised;
 * otherwise HOLD. When NOTHING crosses — the common case — the PREV `state`
 * reference is returned unchanged, which the reactor's `scan` reads as "no
 * publish" (see the module docstring). A raise/clear returns a fresh `Alerts`.
 */
export function applyHysteresis(state: Alerts, frame: MetricsFrame): Alerts {
  const raised = new Map(state.items.map((i) => [i.id, i]));
  let changed = false;

  for (const id of METRIC_IDS) {
    const pct = frame[id];
    const isRaised = raised.has(id);
    if (!isRaised && pct >= RAISE_PCT) {
      raised.set(id, { id });
      changed = true;
    } else if (isRaised && pct < CLEAR_PCT) {
      raised.delete(id);
      changed = true;
    }
  }

  // No threshold crossed — return the PREV reference so `scan` publishes
  // nothing. This is REQUIRED, not an optimization: a fresh object here would
  // step the graph every quiet tick.
  if (!changed) return state;

  // Rebuild in the fixed metric order so the item list is deterministic
  // regardless of raise sequence.
  return {
    items: METRIC_IDS.flatMap((id) => {
      const item = raised.get(id);
      return item ? [item] : [];
    }),
  };
}

/** Equal iff the SAME set of alert ids is raised — the cell's `equals` gate. A
 *  metric whose pct drifts within the same raised level publishes nothing (the
 *  id set is unchanged); only a raise or a clear crosses the wire. */
export function alertsEqual(a: Alerts, b: Alerts): boolean {
  if (a.items.length !== b.items.length) return false;
  const ids = new Set(a.items.map((i) => i.id));
  return b.items.every((i) => ids.has(i.id));
}
