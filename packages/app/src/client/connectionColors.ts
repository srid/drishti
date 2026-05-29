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
  disconnected: {
    dotBg: "bg-red-500",
    text: "text-red-500",
    label: "no data",
    message: "Disconnected. Retrying…",
    pending: false,
  },
};
