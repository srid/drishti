/**
 * The THIN `@kolu/surface-map` `EntryStatus` consumption seam.
 *
 * One small, pure module — no JSX, no `wire` — is the SOLE place drishti
 * reads `entry.state()` and turns it into a connection-dot tone / status
 * label, mirroring kolu's own `hostChipTone.ts`. Every host indicator (the
 * tab chip, the fleet card) goes through `dotClass`/`statusLabel` here, so
 * absorbing a wire change to `EntryStatus` is a ONE-FILE edit, not a scatter
 * across every component that paints a dot. PR4 landed exactly such a change:
 * the `failed` arm now carries a schema-valid domain `failure` value
 * (`EntryStatus<Failure>`), read here as `status.failure.reason` — drishti's
 * `HostFailure` is just `{ reason }`, since it paints a cause-blind dot. kolu#2022
 * added that reason's `evidence` on the same arm, read here by `failureRecord`.
 *
 * `EntryStatus` is the map's FACT, floored on real transport liveness by
 * `connectSurfaceMap` (see its README) — it replaces the old per-host
 * `SurfaceHealth`/`gateStatus` fold this file's callers used to read
 * (`app.health()`, which no longer exists per host now that every host's
 * data rides the ONE admin transport instead of its own socket).
 */

import type { EntryState, FailureEvidence } from "@kolu/surface-map";
import {
  type ConnectionInfo,
  type ConnectionState,
  DEFAULT_CONNECTION,
} from "drishti-common/browser";

// A pure kind→tone lookup as a `Record` keyed on the full `EntryState["kind"]`
// union — so adding a fourth displayed kind is a compile error here
// (exhaustive by construction), not a silent fall-through a `switch` would
// hide.
const DOT_TONE: Record<EntryState["kind"], string> = {
  connected: "bg-emerald-500", // live — the map floors this on transport liveness
  warming: "bg-amber-500", // probing / provisioning / connecting — coming up
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
export function statusTitle(status: EntryState<{ reason: string }>): string {
  switch (status.kind) {
    case "connected":
      return "connected";
    case "warming":
      return "connecting…";
    case "failed":
      return `failed: ${status.failure.reason}`;
    default:
      return "not a member";
  }
}

/** The failed entry's POST-MORTEM record — the domain `reason` together with the
 *  `evidence` the framework staples to it (kolu#2022), `null` when the entry is not
 *  failed. Read through this seam, beside the dot, so the failure page and the dot's
 *  tooltip can't disagree about whether a host is failed.
 *
 *  Evidence is the retained output tail (`{source, line}`), pinned by `serveHostMap`
 *  at the SAME classification seam that produced the reason — it is not the live
 *  `connection.log` this page used to read. That distinction is the whole point:
 *  `connectSurfaceMap`'s liveness floor DROPS `connection` over a dead admin link but
 *  KEEPS the failure record, so reading the tail off the live payload lost the actual
 *  error output at exactly the moment a user was staring at a broken host. Off the
 *  failure record, the reason and its evidence arrive or vanish together. */
export function failureRecord(
  status: EntryState<{ reason: string }>,
): { reason: string; evidence: FailureEvidence } | null {
  return status.kind === "failed"
    ? { reason: status.failure.reason, evidence: status.evidence }
    : null;
}

/** Whether this status should pulse (work in progress). A terminally-failed
 *  or fully-connected entry sits steady; only `warming` is "in flight". */
export function statusPending(status: EntryState): boolean {
  return status.kind === "warming";
}

/**
 * The FINE connection (the status *word*), read from the SAME `entry.state()`
 * frame the dot reads — SR9's "one connection authority" on the drishti client.
 *
 * The word used to ride a SECOND, independent `cells.connection` subscription
 * that could lag or wedge at "connecting…" while the entry's `EntryStatus` (the
 * dot) had already gone green — srid/drishti#102. SR9 folds the fine connection
 * ONTO the entry (`EntryState<Failure, ConnectionInfo>.connection`), co-produced
 * with the coarse arm from one `SessionState` frame in kolu's single
 * `serveHostMap` resolve. Deriving the word HERE — the sole `entry.state()` seam,
 * beside `dotClass` — means the dot and the word cannot disagree: there is one
 * source. A `not-a-member` entry (never reached) carries no connection.
 *
 * Neither does a FAILED one, since kolu#2022: a live word is work-in-flight and a
 * failed entry has none — its post-mortem is the `failureRecord` instead. So this
 * returns the payload only for the two LIVE arms, and callers that paint a word
 * must go through `connectionPhaseOf` rather than defaulting the absence.
 */
export function connectionOf<F>(
  status: EntryState<F, ConnectionInfo>,
): ConnectionInfo | undefined {
  return status.kind === "not-a-member" || status.kind === "failed"
    ? undefined
    : status.connection;
}

/** The connection PHASE to PAINT beside the dot — the one word authority, total over
 *  every `EntryState` arm.
 *
 *  This exists because `connectionOf(...) ?? DEFAULT_CONNECTION` is a TRAP on a failed
 *  entry. `DEFAULT_CONNECTION` is the gate-closed placeholder for "no frame has arrived
 *  yet", and its phase is `connecting` — so defaulting a failed entry's absent payload
 *  painted an amber "connecting…" word beside the red dot, with the real reason sitting
 *  right there on the entry. That was drishti#102's split reopened on the other side:
 *  one frame, two disagreeing renders. Before kolu#2022 it only bit when the liveness
 *  floor dropped `connection` off a failed entry (a dead admin link — exactly
 *  juspay/kolu#2007); now the failed arm carries no payload at ALL, so the default
 *  would fire on every failed host.
 *
 *  A failed entry's word is `failed`, read off the coarse arm the dot reads. Only the
 *  live arms fall back to `DEFAULT_CONNECTION`'s phase, which is what that value means. */
export function connectionPhaseOf(
  status: EntryState<{ reason: string }, ConnectionInfo>,
): ConnectionState {
  return status.kind === "failed"
    ? "failed"
    : (connectionOf(status)?.phase ?? DEFAULT_CONNECTION.phase);
}
