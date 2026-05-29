/**
 * Pure metric derivations shared by the per-host header and the fleet
 * overview cards. Kept free of Solid and DOM so the aggregation maths
 * (the part that's wrong at runtime if the formula slips) is unit
 * testable in isolation — `import type` erases the surface dependency so
 * `bun test` never loads zod / @kolu/surface.
 */

import type { SystemInfo } from "../common/surface";

/** Memory used as a percentage of total. Zero when total is unknown
 *  (a freshly-connected host whose first `system` tick hasn't landed),
 *  so callers never divide by zero. */
export function memPct(system: SystemInfo): number {
  return system.memTotal > 0 ? (100 * system.memUsed) / system.memTotal : 0;
}

/** Used / total memory in gigabytes, formatted to one decimal — the
 *  string form the header and the fleet cards both render. */
export function memGb(system: SystemInfo): { used: string; total: string } {
  return {
    used: (system.memUsed / 1e9).toFixed(1),
    total: (system.memTotal / 1e9).toFixed(1),
  };
}

/** Coarse, human-friendly uptime: days+hours, hours+minutes, or minutes.
 *  Matches the granularity htop-style headers show — nobody reads
 *  seconds-of-uptime at a glance. */
export function formatUptime(uptimeSec: number): string {
  const d = Math.floor(uptimeSec / 86400);
  const h = Math.floor((uptimeSec % 86400) / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Mean busy-percentage across the supplied per-core usages — the single
 *  "host CPU%" number the fleet card shows in place of the full per-core
 *  strip. Zero for a host with no reported cores (e.g. not yet
 *  connected), never NaN. */
export function averageCoreUsage(usages: readonly number[]): number {
  if (usages.length === 0) return 0;
  return usages.reduce((s, u) => s + u, 0) / usages.length;
}
