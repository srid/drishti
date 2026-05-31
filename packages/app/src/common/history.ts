/**
 * The pure, framework-free metric-history domain — shared by the **parent**
 * (which owns the in-memory ring and samples it on every poll tick) and the
 * **browser** (which renders the ring it's streamed). Keeping the ring
 * maths (eviction, windowing, SVG projection — the part that's wrong on
 * screen, or wrong in memory, if an index or a scale slips) in one
 * framework-free module lets it be unit-tested in isolation and reused on
 * both sides of the wire.
 *
 * The history is **server-side and in-memory**: it lives in the parent for
 * the life of the process, accruing for every connected host whether or not
 * a browser tab is open on it. A browser gets the whole ring on connect
 * (snapshot) then per-tick deltas — so reloads and tab switches both replay
 * the full history instantly. It is never persisted to disk (preserving the
 * zero-config posture); restarting the parent starts fresh.
 */

import type { MetricSample, SystemInfo } from "drishti-common";
import { averageCoreUsage, diskPct, memPct } from "./metrics";

/** The series the chart draws. */
export type MetricKey = "cpu" | "mem" | "disk";

/** Selectable chart windows, mirroring the time-range chips popular
 *  monitors (Netdata, btop, Datadog) put above their graphs. Ascending by
 *  span; the widest doubles as the ring's retention bound. */
export const HISTORY_WINDOWS = [
  { key: "1m", ms: 60_000 },
  { key: "5m", ms: 5 * 60_000 },
  { key: "15m", ms: 15 * 60_000 },
  { key: "30m", ms: 30 * 60_000 },
] as const;

export type HistoryWindowKey = (typeof HISTORY_WINDOWS)[number]["key"];

/** The widest selectable window — the one the fleet card sparkline pins to,
 *  so the card always shows the same span as the retention bound. Derived
 *  from the last entry (the array is ascending by span) so adding a wider
 *  window automatically widens the sparkline too. */
// Non-null assertion: HISTORY_WINDOWS is a non-empty const tuple, so .at(-1)
// always resolves. TypeScript can't prove this from the index type alone.
export const WIDEST_HISTORY_WINDOW: HistoryWindowKey =
  HISTORY_WINDOWS.at(-1)!.key;

/** Default window on first open — the middle ground popular monitors land
 *  on: long enough to show a trend, short enough to stay responsive. */
export const DEFAULT_HISTORY_WINDOW: HistoryWindowKey = "5m";

/** Retention bound for the ring: the widest selectable window. Samples
 *  older than this are evicted on push, so a host left open for hours
 *  still holds at most the widest window's worth of points. Derived from
 *  the window set so it can't drift below a selectable window — adding a
 *  wider window automatically widens retention to match. */
export const HISTORY_RETENTION_MS = Math.max(
  ...HISTORY_WINDOWS.map((w) => w.ms),
);

/** Resolve a window key to its span in ms, falling back to the narrowest
 *  window if the key is somehow unknown (never NaN). */
export function windowMsFor(key: HistoryWindowKey): number {
  return HISTORY_WINDOWS.find((w) => w.key === key)?.ms ?? HISTORY_WINDOWS[0].ms;
}

/** Whether a raw string is a selectable window key — the guard for
 *  restoring a persisted choice, so a key dropped from a future build
 *  falls back to the default instead of selecting nothing. */
export function isHistoryWindowKey(raw: string): boolean {
  return HISTORY_WINDOWS.some((w) => w.key === raw);
}

/** Assemble a `MetricSample` from a live system snapshot and the per-core
 *  usages captured at one instant — the single home for "what a captured
 *  sample is." Each series maps to its own derivation (a CPU mean, a memory
 *  share, a disk share), so adding one touches the data layer it comes from:
 *  the `MetricKey` union, the `MetricSample` schema, and this assembler. The
 *  *render* side (which polylines/legend chips to draw) is single-sourced
 *  separately in the client's `SERIES` table, so it costs no edit here. Pure:
 *  `t` is passed in, and every derivation reuses a canonical `metrics.ts`
 *  helper rather than re-deriving inline. */
export function captureSample(
  t: number,
  system: SystemInfo,
  coreUsages: readonly number[],
): MetricSample {
  return {
    t,
    cpu: averageCoreUsage(coreUsages),
    mem: memPct(system),
    disk: diskPct(system),
  };
}

/** Append a sample and evict any older than `retentionMs` behind the
 *  newest. Returns a new array (the caller holds it in a signal or a
 *  closure cell); the input is never mutated. The cutoff is measured from
 *  the newest timestamp across the whole ring — not blindly from the
 *  incoming sample — so a backwards clock blip can't wipe the buffer. */
export function pushSample(
  buffer: readonly MetricSample[],
  sample: MetricSample,
  retentionMs: number,
): MetricSample[] {
  const next = [...buffer, sample];
  const newest = next.reduce((max, s) => (s.t > max ? s.t : max), sample.t);
  const cutoff = newest - retentionMs;
  return next.filter((s) => s.t >= cutoff);
}

/** The slice within `windowMs` of `now` — what the chart draws for the
 *  selected duration. `now` is passed in (not read from the clock) so the
 *  projection stays pure and testable. */
export function windowSlice(
  buffer: readonly MetricSample[],
  windowMs: number,
  now: number,
): MetricSample[] {
  const cutoff = now - windowMs;
  return buffer.filter((s) => s.t >= cutoff);
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Project samples to an SVG polyline `points` string in a 0-100 × 0-100
 *  viewBox. X maps time across the window (left edge = `now - windowMs`,
 *  right edge = `now`) so the trace fills in from the right as data
 *  accrues, exactly like the time-range graphs in btop/Netdata. Y inverts
 *  the 0-100 metric (SVG's origin is top-left, so 100% sits at y=0). Both
 *  axes are clamped to the band. Empty input yields "". */
export function polylinePoints(
  samples: readonly MetricSample[],
  key: MetricKey,
  now: number,
  windowMs: number,
): string {
  const start = now - windowMs;
  return samples
    .map((s) => {
      const x = clamp(((s.t - start) / windowMs) * 100, 0, 100);
      const y = 100 - clamp(s[key], 0, 100);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}
