/**
 * Pure metric math shared across tiers — framework-free, no runtime deps.
 *
 * `averageCoreUsage` lives HERE (not in the app) because the **agent** is the
 * SOLE producer of the host-CPU aggregate: it reads per-core usage each tick and
 * folds the mean into the `system` cell's `cpuPct` (see `agent/src/main.ts`).
 * Every downstream tier — the parent re-serve and the browser — reads that one
 * pre-computed `system.cpuPct` scalar and does NOT re-derive the mean (the old
 * shape, where the fleet card averaged the `cpuCores` collection client-side, was
 * the O(hosts×cores) fan-out this collapsed). The formula sits in the one package
 * the agent can import; its only non-test consumer is the agent.
 */

/** Mean busy-percentage across the supplied per-core usages — the single
 *  "host CPU%" number. Zero for a host with no reported cores (e.g. not yet
 *  connected), never NaN. */
export function averageCoreUsage(usages: readonly number[]): number {
  if (usages.length === 0) return 0;
  return usages.reduce((s, u) => s + u, 0) / usages.length;
}
