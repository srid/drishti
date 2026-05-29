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

import type { SystemInfo } from "./surface";

/** Memory used as a percentage of total. Zero when total is unknown
 *  (a freshly-connected host whose first `system` tick hasn't landed),
 *  so callers never divide by zero. */
export function memPct(system: SystemInfo): number {
  return system.memTotal > 0 ? (100 * system.memUsed) / system.memTotal : 0;
}

/** Mean busy-percentage across the supplied per-core usages — the single
 *  "host CPU%" number the fleet card and the history ring both use. Zero
 *  for a host with no reported cores (e.g. not yet connected), never NaN. */
export function averageCoreUsage(usages: readonly number[]): number {
  if (usages.length === 0) return 0;
  return usages.reduce((s, u) => s + u, 0) / usages.length;
}
