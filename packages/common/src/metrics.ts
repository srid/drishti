/**
 * Pure metric math shared across tiers — framework-free, no runtime deps.
 *
 * `averageCoreUsage` lives HERE (not in the app) because the **agent** is the
 * producer of the host-CPU aggregate: it reads per-core usage each tick and
 * folds it into the `system` cell's `cpuPct` (see `agent/src/main.ts`). The
 * parent re-serve and the browser then read that one scalar rather than each
 * re-deriving the mean — so the formula has a single home both the agent and
 * the app import, the "reuse the source of truth" principle applied to a number
 * three tiers were independently computing.
 */

/** Mean busy-percentage across the supplied per-core usages — the single
 *  "host CPU%" number. Zero for a host with no reported cores (e.g. not yet
 *  connected), never NaN. */
export function averageCoreUsage(usages: readonly number[]): number {
  if (usages.length === 0) return 0;
  return usages.reduce((s, u) => s + u, 0) / usages.length;
}
