/**
 * Pure numeric metric derivations shared across tiers: the browser uses
 * them for the header / fleet-card usage bars, and the parent uses them to
 * build the metric-history ring (`common/history.ts`). Kept framework-free
 * — `import type` erases the surface dependency so they carry no zod /
 * @kolu runtime weight and stay trivially unit-testable.
 *
 * UI-only formatting (GB strings, uptime, byte sizes) lives in
 * `client/metrics.ts`, which re-exports these two so existing client
 * imports keep resolving against one module.
 */

import type { SystemInfo } from "drishti-common";

// `averageCoreUsage` lives in `drishti-common/metrics` — the agent is the
// producer of the host-CPU aggregate (it folds the mean into `system.cpuPct`),
// so the formula moved to the package the agent can import. Consumers import it
// from there directly; it is not re-exported through this app-only module.

/** `part` as a percentage of `whole`, guarded: 0 when `whole` is 0 (or
 *  negative) so callers never divide by zero — e.g. a freshly-connected host
 *  whose first `system` tick hasn't landed yet reports a 0 total. The single
 *  "share of a total" formula, used for both host memory (`memPct`) and a
 *  process's share of host RAM in the detail panel. */
export function pctOf(part: number, whole: number): number {
  return whole > 0 ? (100 * part) / whole : 0;
}

/** Memory used as a percentage of total. */
export function memPct(system: SystemInfo): number {
  return pctOf(system.memUsed, system.memTotal);
}

/** Root-filesystem used as a percentage of total — the disk twin of
 *  `memPct`, reusing the same guarded `pctOf` formula. 0 when the host
 *  reports no disk total (agent couldn't `statfs`), never NaN. */
export function diskPct(system: SystemInfo): number {
  return pctOf(system.diskUsed, system.diskTotal);
}
