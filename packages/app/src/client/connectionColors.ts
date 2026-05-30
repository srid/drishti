/**
 * Per-connection-state presentation, single-sourced. Each state maps to
 * one `StatePresentation` row rather than living as five parallel
 * `Record<ConnectionState, …>` maps — `Record` totality already forces
 * every state to be present, but one map also forces every *aspect*
 * (dot colour, text colour, terse label, verbose message, pending flag)
 * to be filled in together, so they can't drift and adding a state is a
 * single row, not five edits.
 */

import type { ConnectionState } from "../common/surface";

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
