/**
 * Pure convergence poll/projection helpers (W3.4) — extracted so UI policy
 * is unit-testable without mounting Solid components.
 *
 * Standing law: a poll failure is its OWN typed state — never erase a
 * standing anomaly with catch-to-null.
 */

export type ConvergenceAnomalyWire = {
  kind: string;
  detail: string;
  error?: string;
};

export type ConvergencePollState = {
  anomaly: ConvergenceAnomalyWire | null;
  pollError: string | null;
};

/** Fold a successful admin hosts.convergence response into poll state. */
export function applyConvergencePollOk(
  prev: ConvergencePollState,
  anomaly: ConvergenceAnomalyWire | null,
): ConvergencePollState {
  return { anomaly, pollError: null };
}

/**
 * Fold a poll failure. Standing anomaly is RETAINED; pollError is set.
 * Mutation restoring catch-to-null would replace this with
 * `{ anomaly: null, pollError: null }` and must go red.
 */
export function applyConvergencePollError(
  prev: ConvergencePollState,
  message: string,
): ConvergencePollState {
  return { anomaly: prev.anomaly, pollError: message };
}

/**
 * Whether the convergence banner is visible for a host connection phase.
 * Standing refuse / drain-persist anomalies remain visible while disconnected
 * (never gated on phase === "connected").
 */
export function convergenceBannerVisible(
  anomaly: ConvergenceAnomalyWire | null,
  _phase: string,
): boolean {
  return anomaly !== null;
}
