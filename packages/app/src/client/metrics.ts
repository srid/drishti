/**
 * Client-side metric formatting for the per-host header and the fleet
 * overview cards — GB strings, uptime, byte/throughput sizes. Kept free of
 * Solid and DOM so it's unit testable in isolation.
 *
 * The numeric derivations (`memPct`, `diskPct`, `pctOf`) live in
 * `common/metrics.ts` because the parent's history sampler needs them too;
 * they're re-exported here so existing client imports keep resolving against
 * one module. (`averageCoreUsage` lives in `drishti-common/metrics` — the agent
 * produces the CPU aggregate — and is imported from there directly.)
 */

import type { SystemInfo } from "drishti-common";

export { diskPct, memPct, pctOf } from "../common/metrics";

/** Used / total memory in gigabytes, formatted to one decimal — the
 *  string form the header and the fleet cards both render. */
export function memGb(system: SystemInfo): { used: string; total: string } {
  return {
    used: (system.memUsed / 1e9).toFixed(1),
    total: (system.memTotal / 1e9).toFixed(1),
  };
}

/** Used / total root-filesystem space in gigabytes, formatted to one
 *  decimal — the disk twin of `memGb`, same decimal-GB convention. */
export function diskGb(system: SystemInfo): { used: string; total: string } {
  return {
    used: (system.diskUsed / 1e9).toFixed(1),
    total: (system.diskTotal / 1e9).toFixed(1),
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
