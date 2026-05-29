/**
 * Usage-percentage → Tailwind colour, single-sourced so the emerald /
 * amber / red palette can't drift between the memory bar, the per-core
 * bars, and the per-process columns. The *thresholds* differ per surface
 * (a core at 80% is hot; memory at 80% is merely amber), but the palette
 * is one decision — `severityBg` owns it.
 */

// Named thresholds so a caller can't silently invert severity by
// swapping two positional numbers (`severityBg(pct, 85, 65)`).
function severityBg(pct: number, at: { amber: number; red: number }): string {
  if (pct > at.red) return "bg-red-500";
  if (pct > at.amber) return "bg-amber-500";
  return "bg-emerald-500";
}

/** Memory / overall usage bar fill — amber past 65%, red past 85%. */
export function usageBarColor(pct: number): string {
  return severityBg(pct, { amber: 65, red: 85 });
}

/** Per-core CPU bar fill — runs hotter, so amber past 50%, red past 80%. */
export function coreUsageColor(pct: number): string {
  return severityBg(pct, { amber: 50, red: 80 });
}

/** Per-process CPU%/MEM% text colour. Distinct from the bars: it tints
 *  text (not background) and leans on a neutral resting colour rather
 *  than emerald, since a table of mostly-idle rows shouldn't glow green. */
export function processPctColor(pct: number): string {
  if (pct > 50) return "font-semibold text-red-500";
  if (pct > 10) return "text-amber-500";
  return "text-gray-700 dark:text-gray-400";
}
