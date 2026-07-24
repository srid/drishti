/**
 * Per-connection-state presentation, single-sourced. Each state maps to
 * one `StatePresentation` row rather than living as parallel
 * `Record<ConnectionState, …>` maps — `Record` totality already forces
 * every state to be present, but one map also forces every *aspect*
 * (text colour, terse label, verbose message, pending flag) to be filled
 * in together, so they can't drift and adding a state is a single row,
 * not four edits.
 *
 * This drives the RICH per-host `connection` cell UI (the connecting
 * overlay, the failed card, the open-host header's status word) — the
 * detailed `ConnectionState`/`FailureCause`/progress-line story
 * `EntryStatus` doesn't carry. The status DOT itself reads a coarser fact
 * now: `@kolu/surface-map`'s `EntryStatus` (`entryStatusTone.ts`), not this
 * module — see `HostDot.tsx`.
 */

import type { ConnectionState, FailureCause } from "drishti-common/browser";

type StatePresentation = {
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
    text: "text-emerald-500",
    label: "connected",
    message: "Connected.",
    pending: false,
  },
  connecting: {
    text: "text-amber-500",
    label: "connecting…",
    message: "Connecting…",
    pending: true,
  },
  // `probing` is the ssh connector's first up-phase, before potentially long
  // provisioning. It's a calm "reaching the host" beat — presented
  // exactly like `connecting` (amber, pulsing) rather than a distinct chip,
  // since the fine phase story rides the progress line, not this coarse map.
  probing: {
    text: "text-amber-500",
    label: "connecting…",
    message: "Connecting…",
    pending: true,
  },
  provisioning: {
    text: "text-amber-500",
    label: "provisioning agent…",
    message: "Provisioning agent on remote…",
    pending: true,
  },
  // Transient: the link dropped and the parent is cycling through
  // another connect attempt. Amber + pulsing says "working on it" —
  // honest, unlike the old red "Retrying…" that also covered give-up.
  disconnected: {
    text: "text-amber-500",
    label: "reconnecting…",
    message: "Reconnecting…",
    pending: true,
  },
  // Terminal: the parent's reconnect loop gave up. Solid red, no pulse —
  // nothing is happening until the user acts. The overlay pairs this
  // headline with `lastError` and a Reconnect button.
  failed: {
    text: "text-red-500",
    label: "failed",
    message: "Connection failed",
    pending: false,
  },
};
