/**
 * Connection-state → Tailwind colour maps, single-sourced so the header
 * text (`STATE_TEXT`), the tab-strip dots, and the fleet-card dots
 * (`DOT_BG`) can't drift apart. Both are total over `ConnectionState`,
 * so adding a state is a compile error until every surface is updated.
 */

import type { ConnectionState } from "../common/surface";

/** Text colour for an inline "● connected" style label. */
export const STATE_TEXT: Record<ConnectionState, string> = {
  connected: "text-emerald-500",
  disconnected: "text-red-500",
  copying: "text-amber-500",
  connecting: "text-amber-500",
};

/** Background colour for a status dot. */
export const DOT_BG: Record<ConnectionState, string> = {
  connected: "bg-emerald-500",
  disconnected: "bg-red-500",
  copying: "bg-amber-500",
  connecting: "bg-amber-500",
};

/** Whether a dot for this state should pulse (work-in-progress states). */
export function isPendingState(state: ConnectionState): boolean {
  return state === "copying" || state === "connecting";
}
