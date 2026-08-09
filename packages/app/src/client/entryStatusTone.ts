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

import { type EntryState, type FailureEvidence, isSettling } from "@kolu/surface-map";
import {
  type ConnectionInfo,
  type ConnectionState,
  DEFAULT_CONNECTION,
} from "drishti-common/browser";

// A pure kind→tone lookup as a `Record` keyed on the full `EntryState["kind"]`
// union — so adding a displayed kind is a compile error here (exhaustive by
// construction), not a silent fall-through a `switch` would hide.
const DOT_TONE: Record<EntryState["kind"], string> = {
  connected: "bg-emerald-500", // live — the map floors this on transport liveness
  warming: "bg-amber-500", // probing / provisioning / connecting — coming up
  failed: "bg-red-500", // provisioning or link failed
  // We cannot see the publisher, so we say nothing about the host: grey, never
  // the amber that means "coming up" and never the red that means "failed".
  unobservable: "bg-gray-400 dark:bg-gray-600",
  "not-a-member": "bg-gray-400 dark:bg-gray-600", // unreached — we only render members
};

/** The connection dot's tailwind background class. */
export function dotClass(status: EntryState): string {
  return DOT_TONE[status.kind];
}

// The three lookups below were `switch (status.kind)` with a `default:`, which is
// how a new arm gets silently painted as an existing one — `unobservable` would
// have landed on amber "connecting…", the exact conflation kolu#2129 split apart.
// They are `Record`s now, for the same reason `DOT_TONE` always was.

/** The status-word text color class, following the same tone. */
const TEXT_TONE: Record<EntryState["kind"], string> = {
  connected: "text-emerald-500",
  warming: "text-amber-500",
  failed: "text-red-500",
  unobservable: "text-gray-500",
  "not-a-member": "text-amber-500",
};
export function statusTextClass(status: EntryState): string {
  return TEXT_TONE[status.kind];
}

/** A terse label — the fleet card / tab-chip tight fallback. */
const LABEL: Record<EntryState["kind"], string> = {
  connected: "connected",
  warming: "connecting…",
  failed: "failed",
  // Not "connecting…": that word claims a campaign is under way, and this arm
  // means we have lost the ability to see whether one is.
  unobservable: "unknown",
  "not-a-member": "not configured",
};
export function statusLabel(status: EntryState): string {
  return labelForKind(status.kind);
}
/** The same label from a bare arm name — for the one caller (the tab chip's tooltip)
 *  that holds the kind without the whole state. Exported rather than letting that
 *  caller interpolate the raw arm into user-visible text, which is how `unobservable`
 *  would have shown up in a tooltip as the word "unobservable". */
export function labelForKind(kind: EntryState["kind"]): string {
  return LABEL[kind];
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
    // The one arm whose tooltip is genuinely the most useful thing on screen: the
    // host is probably fine and our admin link is not, so name the last word we
    // actually heard rather than pretending to a current one.
    case "unobservable":
      return `status unknown — drishti can't reach this host's publisher (last seen: ${status.published})`;
    case "not-a-member":
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

/** Whether this status should pulse (unsettled). A terminally-failed or fully-connected
 *  entry sits steady; `warming` and `unobservable` are both "not settled yet".
 *
 *  Delegates to the framework's `isSettling` rather than re-spelling `kind === "warming"`:
 *  that test used to be right and stopped being right the moment the floor grew its own
 *  arm — a dropped admin link would have frozen the pulse on a host that is still very
 *  much in motion. This is the one call kolu#2129 added so the spin-only consumer pays
 *  nothing for the split. */
export function statusPending(status: EntryState): boolean {
  return isSettling(status);
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
 * failed entry has none — its post-mortem is the `failureRecord` instead. Nor does
 * an `unobservable` one (kolu#2129): our own link to the publisher is down, so the
 * last word we heard is by definition frozen, and the arm carries no field for it.
 * So this returns the payload only for the two LIVE arms, and callers that paint a
 * word must go through `connectionPhaseOf` rather than defaulting the absence.
 *
 * Spelled as a POSITIVE test on the two arms that have the field, not a negative
 * list of the ones that don't: a negative list silently admits every future arm
 * into the "live" bucket, which is how the previous spelling would have read a
 * blind entry as one carrying a current connection.
 */
export function connectionOf<F>(
  status: EntryState<F, ConnectionInfo>,
): ConnectionInfo | undefined {
  return status.kind === "connected" || status.kind === "warming"
    ? status.connection
    : undefined;
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
 *  live arms fall back to `DEFAULT_CONNECTION`'s phase, which is what that value means.
 *
 *  `unobservable` (kolu#2129) is the same trap wearing a different hat, and is caught the
 *  same way: it has no payload either, so the default would have painted "connecting…"
 *  over a host whose publisher we simply cannot hear. Its word is `disconnected` — a
 *  statement about the link we lost, which is the only thing we actually know. */
export function connectionPhaseOf(
  status: EntryState<{ reason: string }, ConnectionInfo>,
): ConnectionState {
  if (status.kind === "failed") return "failed";
  if (status.kind === "unobservable") return "disconnected";
  return connectionOf(status)?.phase ?? DEFAULT_CONNECTION.phase;
}
