/**
 * Usage-percentage → Tailwind colour, single-sourced so the emerald /
 * amber / red palette can't drift between the memory bar, the per-core
 * bars, and the per-process columns. The *thresholds* differ per surface
 * (a core at 80% is hot; memory at 80% is merely amber), but the palette
 * is one decision — `severityBg` owns it.
 */

function severityBg(pct: number, amberAbove: number, redAbove: number): string {
  if (pct > redAbove) return "bg-red-500";
  if (pct > amberAbove) return "bg-amber-500";
  return "bg-emerald-500";
}

/** Memory / overall usage bar fill — amber past 65%, red past 85%. */
export function usageBarColor(pct: number): string {
  return severityBg(pct, 65, 85);
}

/** Per-core CPU bar fill — runs hotter, so amber past 50%, red past 80%. */
export function coreUsageColor(pct: number): string {
  return severityBg(pct, 50, 80);
}

/** Per-process CPU%/MEM% text colour. Distinct from the bars: it tints
 *  text (not background) and leans on a neutral resting colour rather
 *  than emerald, since a table of mostly-idle rows shouldn't glow green. */
export function processPctColor(pct: number): string {
  if (pct > 50) return "font-semibold text-red-500";
  if (pct > 10) return "text-amber-500";
  return "text-gray-700 dark:text-gray-400";
}
