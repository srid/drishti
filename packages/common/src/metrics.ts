/**
 * Pure metric math shared across tiers — framework-free, no runtime deps.
 *
 * This is the ONE agent-shared home for host-metric derivations. `averageCoreUsage`
 * lives HERE (not in the app) because the **agent** is the SOLE producer of the
 * host-CPU aggregate: it reads per-core usage each tick and folds the mean into the
 * `system` cell's `cpuPct` (see `agent/src/main.ts`). The `pctOf` / `memPct` /
 * `diskPct` share-of-total helpers live here too, so the agent's `alerts` fold
 * (`./alerts`) derives mem%/disk% from the SAME formula the app-tier UI does — the
 * app's client module (`app/src/client/metrics.ts`) re-exports them so its
 * consumers keep resolving against one module, and no tier re-derives the math.
 */

import type { SystemInfo } from "./surface";

/** Mean busy-percentage across the supplied per-core usages — the single
 *  "host CPU%" number. Zero for a host with no reported cores (e.g. not yet
 *  connected), never NaN. */
export function averageCoreUsage(usages: readonly number[]): number {
  if (usages.length === 0) return 0;
  return usages.reduce((s, u) => s + u, 0) / usages.length;
}

/** `part` as a percentage of `whole`, guarded: 0 when `whole` is 0 (or negative)
 *  so callers never divide by zero — a freshly-connected host whose first `system`
 *  tick hasn't landed yet reports a 0 total. The single "share of a total" formula,
 *  used for host memory (`memPct`), swap (`swapPct`), root-fs (`diskPct`), and a
 *  process's share of host RAM in the detail panel. */
export function pctOf(part: number, whole: number): number {
  return whole > 0 ? (100 * part) / whole : 0;
}

/** Memory used as a percentage of total. */
export function memPct(system: SystemInfo): number {
  return pctOf(system.memUsed, system.memTotal);
}

/** Swap used as a percentage of total — the memory twin of `memPct`, reusing
 *  the same guarded `pctOf`. 0 when the host reports no swap total (swap
 *  disabled, or an unknown platform), never NaN. */
export function swapPct(system: SystemInfo): number {
  return pctOf(system.swapUsed, system.swapTotal);
}

/** Root-filesystem used as a percentage of total — the disk twin of `memPct`,
 *  reusing the same guarded `pctOf`. 0 when the host reports no disk total (agent
 *  couldn't `statfs`), never NaN. */
export function diskPct(system: SystemInfo): number {
  return pctOf(system.diskUsed, system.diskTotal);
}

/** The metric-series names — the single vocabulary of "which host metrics
 *  exist." The alert fold (`AlertId`) and the history chart (`MetricKey` in
 *  `common/history.ts`) both key on these, so adding a metric touches this union
 *  and the projection below, not a parallel copy per tier. */
export type MetricKey = "cpu" | "mem" | "swap" | "disk";

/** Project a live `system` snapshot to its per-metric percentages (0-100) — the
 *  ONE system→% projection, consumed by BOTH the parent's history sampler
 *  (`captureSample`) and the agent's alert fold. `cpu` is the agent's
 *  pre-computed `cpuPct`; `mem`/`disk` are the guarded shares above, so no tier
 *  re-derives the formula. */
export function metricPercents(system: SystemInfo): Record<MetricKey, number> {
  return {
    cpu: system.cpuPct,
    mem: memPct(system),
    swap: swapPct(system),
    disk: diskPct(system),
  };
}
