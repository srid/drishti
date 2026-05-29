/**
 * Pure NIC classification — the activity policy the network strip uses to
 * decide which interfaces are worth showing. Kept separate from the
 * formatting helpers in `metrics.ts` (a different volatility axis) and free
 * of Solid/DOM so it stays unit testable in isolation.
 */

import type { NetInterface } from "../common/surface";

/** A NIC counts as "active" only when it moved bytes in the last poll window
 *  — cumulative lifetime totals don't matter. Idle interfaces (both rates 0)
 *  are collapsed by default in the network strip so the handful of busy NICs
 *  aren't buried under the dozens of always-zero virtual ones (utunN, anpiN,
 *  …) a typical host carries. `undefined` (a NIC seen mid-tick churn) is
 *  treated as inactive. */
export function isActiveNic(
  nic: Pick<NetInterface, "rxRate" | "txRate"> | undefined,
): boolean {
  return (nic?.rxRate ?? 0) > 0 || (nic?.txRate ?? 0) > 0;
}
