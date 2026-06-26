/**
 * Per-connection-state presentation, single-sourced. Each state maps to
 * one `StatePresentation` row rather than living as five parallel
 * `Record<ConnectionState, …>` maps — `Record` totality already forces
 * every state to be present, but one map also forces every *aspect*
 * (dot colour, text colour, terse label, verbose message, pending flag)
 * to be filled in together, so they can't drift and adding a state is a
 * single row, not five edits.
 */

import { gateStatus, type SurfaceHealth } from "@kolu/surface/solid";
import type { ConnectionState, FailureCause } from "drishti-common/browser";

type StatePresentation = {
  /** Status-dot background colour. */
  dotBg: string;
  /** Inline "● connected" text colour. */
  text: string;
  /** Terse label — the fleet card's tight fallback. */
  label: string;
  /** Verbose status line — the full-pane connecting overlay. */
  message: string;
  /** Work-in-progress state whose dot should pulse. */
  pending: boolean;
};

/** Append an elapsed-seconds suffix to a pending status message once a
 *  second has ticked — "Connecting…" → "Connecting… 18s". A connect that
 *  drags reads as abnormal *before* the parent's connect watchdog trips
 *  it to `failed`; the live counter is that early signal. Below 1s the
 *  bare message reads cleaner (and avoids a "0s" flash on every state
 *  change), so the suffix is omitted. */
export function withElapsed(message: string, elapsedSec: number): string {
  return elapsedSec >= 1 ? `${message} ${elapsedSec}s` : message;
}

/** Refine the `disconnected` status line by *why* the link is down. A
 *  `"network"` fault means the host is unreachable and the parent retries
 *  indefinitely — "Reconnecting…" undersells a host that's simply asleep
 *  or out of network range, so name it. Any other cause (or none yet) keeps
 *  the base message. Mirrors `withElapsed`: the static `STATE` map stays
 *  cause-agnostic and the renderer interpolates, so no dynamic copy is
 *  baked into the map. */
export function disconnectedMessage(failureCause: FailureCause | null): string {
  return failureCause === "network"
    ? "Host unreachable — retrying…"
    : STATE.disconnected.message;
}

export const STATE: Record<ConnectionState, StatePresentation> = {
  connected: {
    dotBg: "bg-emerald-500",
    text: "text-emerald-500",
    label: "connected",
    message: "Connected.",
    pending: false,
  },
  connecting: {
    dotBg: "bg-amber-500",
    text: "text-amber-500",
    label: "connecting…",
    message: "Connecting…",
    pending: true,
  },
  copying: {
    dotBg: "bg-amber-500",
    text: "text-amber-500",
    label: "provisioning agent…",
    message: "Copying agent to remote…",
    pending: true,
  },
  // Transient: the link dropped and the parent is cycling through
  // another connect attempt. Amber + pulsing says "working on it" —
  // honest, unlike the old red "Retrying…" that also covered give-up.
  disconnected: {
    dotBg: "bg-amber-500",
    text: "text-amber-500",
    label: "reconnecting…",
    message: "Reconnecting…",
    pending: true,
  },
  // Terminal: the parent's reconnect loop gave up. Solid red, no pulse —
  // nothing is happening until the user acts. The overlay pairs this
  // headline with `lastError` and a Reconnect button.
  failed: {
    dotBg: "bg-red-500",
    text: "text-red-500",
    label: "failed",
    message: "Connection failed",
    pending: false,
  },
};

// The framework `<HostStatusPip>` colors its dot via an inline `style.background`
// hex, not a tailwind class, so `<HostDot>` supplies the palette as hex. Only
// THREE are needed, and the split is deliberate: `connected` (green) is passed
// solely as the pip's `readyColor` — emitted only from its fact-`ready` branch,
// so a stale `connected` cell can't paint it — while the not-ready tone is keyed
// to the cell as `failed → red`, else `amber`. The not-ready branch NEVER reads
// `DOT_HEX.connected`, because a `connected` mirror can still be not-ready (a
// pending/erroring sub) and emitting its green there would forge the very lie the
// pip exists to prevent.
export const DOT_HEX = {
  connected: "#10b981", // emerald-500 — the pip's readyColor (fact-gated)
  connecting: "#f59e0b", // amber-500 — every non-`failed` not-ready state
  failed: "#ef4444", // red-500
} as const;

/** The status-WORD color class — green ONLY when the host's FACT is fully READY,
 *  the SAME verdict the adjacent fact-gated `<HostDot>` emits its green from
 *  (`gateStatus(health) === "ready"`: live ∧ no erroring sub ∧ no pending sub).
 *
 *  The word reads the raw mirror cell `state`; the dot reads the whole `health()`
 *  fact. Gating the word's green on the bare `live` boolean was too LOOSE — `live`
 *  is `transport ∧ mirror` and stays `true` while a subscription silently errors
 *  (gateStatus → `degraded`) or is still loading (→ `connecting`). So a green
 *  `connected` word would sit beside an amber dot whenever a sub was dead — the
 *  #1564 lie merely relocated from the dot to the status WORD. Folding the WHOLE
 *  fact through `gateStatus` (never a narrower slice the caller hand-picks) keeps
 *  word and dot the same decision: a `connected` cell that is not ready (transport
 *  down, OR a sub erroring/pending) reads amber, never green; every non-`connected`
 *  state already carries its own non-green tone (`failed` → red). */
export function statusTextClass(
  state: ConnectionState,
  health: SurfaceHealth,
): string {
  if (gateStatus(health) === "ready") return STATE.connected.text; // green — fully ready
  return state === "connected" ? STATE.connecting.text : STATE[state].text;
}
