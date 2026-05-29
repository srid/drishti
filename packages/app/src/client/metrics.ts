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

// Decimal (1000-based) units, matching the GB convention `memGb` uses —
// kept consistent so memory and network sizes read the same way.
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human-friendly byte size: "0 B", "812 B", "1.2 MB", "3.4 GB". Whole
 *  bytes below 1 KB, one decimal above. Decimal units (÷1000), not binary,
 *  to match `memGb`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  // Rounding to one decimal can push the value back up to 1000 (e.g.
  // 999_999 → 999.999 KB → "1000.0 KB"); promote one more unit so it reads
  // "1.0 MB". Guard against the top unit, which has nowhere to promote to.
  if (unit < BYTE_UNITS.length - 1 && Number(value.toFixed(1)) >= 1000) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** Throughput rendered as a per-second byte rate, e.g. "1.2 MB/s". */
export function formatThroughput(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Mean busy-percentage across the supplied per-core usages — the single
 *  "host CPU%" number the fleet card shows in place of the full per-core
 *  strip. Zero for a host with no reported cores (e.g. not yet
 *  connected), never NaN. */
export function averageCoreUsage(usages: readonly number[]): number {
  if (usages.length === 0) return 0;
  return usages.reduce((s, u) => s + u, 0) / usages.length;
}
