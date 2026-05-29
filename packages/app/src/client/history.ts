/**
 * Ephemeral per-host metric history — an in-memory, time-bounded ring of
 * CPU% / memory% samples backing the per-host time-series chart.
 *
 * Pure and Solid-free so the windowing and SVG-projection maths (the part
 * that's wrong on screen if an index or a scale slips) is unit-testable in
 * isolation; the Solid wiring and the `<svg>` itself live in App.tsx.
 *
 * "Ephemeral" is literal: the ring lives inside the `HostView` component
 * for the life of that tab session and is never persisted. Switching away
 * and back starts a fresh history — matching drishti's zero-config,
 * no-storage posture (the in-memory-ring decision from the feature plan).
 */

import type { SystemInfo } from "../common/surface";
import { averageCoreUsage, memPct } from "./metrics";

export interface Sample {
  /** Wall-clock capture time, epoch ms. */
  t: number;
  /** Mean busy-percentage across all cores at capture (0-100). */
  cpu: number;
  /** Memory used as a percentage of total at capture (0-100). */
  mem: number;
}

/** The two series the chart draws. */
export type MetricKey = "cpu" | "mem";

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

/** Default window on first open — the middle ground popular monitors land
 *  on: long enough to show a trend, short enough to stay responsive. */
export const DEFAULT_HISTORY_WINDOW: HistoryWindowKey = "5m";

/** Retention bound for the ring: the widest selectable window. Samples
 *  older than this are evicted on push, so a host left open for hours
 *  still holds at most the widest window's worth of points. */
export const HISTORY_RETENTION_MS = Math.max(
  ...HISTORY_WINDOWS.map((w) => w.ms),
);

/** Resolve a window key to its span in ms, falling back to the narrowest
 *  window if the key is somehow unknown (never NaN). */
export function windowMsFor(key: HistoryWindowKey): number {
  return HISTORY_WINDOWS.find((w) => w.key === key)?.ms ?? HISTORY_WINDOWS[0].ms;
}

/** Assemble a `Sample` from a live system snapshot and the per-core usages
 *  captured at one instant — the single home for "what a captured sample
 *  is." Adding a series (say, load) becomes one edit here plus the chart,
 *  not a change scattered across the capture site too. Pure: `t` is passed
 *  in, and the cpu/mem derivations reuse the canonical helpers from
 *  metrics.ts rather than re-deriving the averaging/ratio. */
export function captureSample(
  t: number,
  system: SystemInfo,
  coreUsages: readonly number[],
): Sample {
  return { t, cpu: averageCoreUsage(coreUsages), mem: memPct(system) };
}

/** Append a sample and evict any older than `retentionMs` behind the
 *  newest. Returns a new array (the caller holds it in a signal); the
 *  input is never mutated. The cutoff is measured from the newest
 *  timestamp across the whole ring — not blindly from the incoming
 *  sample — so a backwards clock blip can't wipe the buffer. */
export function pushSample(
  buffer: readonly Sample[],
  sample: Sample,
  retentionMs: number,
): Sample[] {
  const next = [...buffer, sample];
  const newest = next.reduce((max, s) => (s.t > max ? s.t : max), sample.t);
  const cutoff = newest - retentionMs;
  return next.filter((s) => s.t >= cutoff);
}

/** The slice within `windowMs` of `now` — what the chart draws for the
 *  selected duration. `now` is passed in (not read from the clock) so the
 *  projection stays pure and testable. */
export function windowSlice(
  buffer: readonly Sample[],
  windowMs: number,
  now: number,
): Sample[] {
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
  samples: readonly Sample[],
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
