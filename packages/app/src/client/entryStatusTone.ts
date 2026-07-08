/**
 * The THIN `@kolu/surface-map` `EntryStatus` consumption seam.
 *
 * One small, pure module — no JSX, no `wire` — is the SOLE place drishti
 * reads `entry.state()` and turns it into a connection-dot tone / status
 * label, mirroring kolu's own `hostChipTone.ts`. Every host indicator (the
 * tab chip, the fleet card) goes through `dotClass`/`statusLabel` here, so
 * absorbing a future wire change to `EntryStatus` — e.g. a typed
 * `failed.cause` discriminant (`EntryStatus<Cause extends string =
 * string>`, pending upstream review) — is a ONE-FILE edit, not a scatter
 * across every component that paints a dot.
 *
 * `EntryStatus` is the map's FACT, floored on real transport liveness by
 * `connectSurfaceMap` (see its README) — it replaces the old per-host
 * `SurfaceHealth`/`gateStatus` fold this file's callers used to read
 * (`app.health()`, which no longer exists per host now that every host's
 * data rides the ONE admin transport instead of its own socket).
 */

import type { EntryState } from "@kolu/surface-map";

// A pure kind→tone lookup as a `Record` keyed on the full `EntryState["kind"]`
// union — so adding a fourth displayed kind is a compile error here
// (exhaustive by construction), not a silent fall-through a `switch` would
// hide.
const DOT_TONE: Record<EntryState["kind"], string> = {
  connected: "bg-emerald-500", // live — the map floors this on transport liveness
  warming: "bg-amber-500", // copying / connecting / pre-clock-offset — coming up
  failed: "bg-red-500", // provisioning or link failed
  "not-a-member": "bg-gray-400 dark:bg-gray-600", // unreached — we only render members
};

/** The connection dot's tailwind background class. */
export function dotClass(status: EntryState): string {
  return DOT_TONE[status.kind];
}

/** The status-word text color class, following the same tone. */
export function statusTextClass(status: EntryState): string {
  switch (status.kind) {
    case "connected":
      return "text-emerald-500";
    case "failed":
      return "text-red-500";
    default:
      return "text-amber-500";
  }
}

/** A terse label — the fleet card / tab-chip tight fallback. */
export function statusLabel(status: EntryState): string {
  switch (status.kind) {
    case "connected":
      return "connected";
    case "warming":
      return "connecting…";
    case "failed":
      return "failed";
    default:
      return "not configured";
  }
}

/** A one-line human note for the dot's `title` — the failure reason when
 *  failed. */
export function statusTitle(status: EntryState): string {
  switch (status.kind) {
    case "connected":
      return "connected";
    case "warming":
      return "connecting…";
    case "failed":
      return `failed: ${status.reason}`;
    default:
      return "not a member";
  }
}

/** Whether this status should pulse (work in progress). A terminally-failed
 *  or fully-connected entry sits steady; only `warming` is "in flight". */
export function statusPending(status: EntryState): boolean {
  return status.kind === "warming";
}
