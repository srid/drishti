/**
 * Project HostSession supervision state to the admin wire DaemonStatus.
 * Pure — unit-tested; admin-router is a thin call site.
 */
import type {
  ConvergenceAnomalyWire,
  DaemonIdentity,
  DaemonStatus,
  HostOutcomeWire,
} from "../common/daemonStatus";
import type {
  DrishtiConvergence,
  HostSession,
  HostSessionOutcome,
} from "./hostRegistry";

/** Project a standing DrishtiConvergence to typed wire (no prose parsing). */
export function projectConvergenceAnomaly(
  c: DrishtiConvergence,
): ConvergenceAnomalyWire {
  const base: ConvergenceAnomalyWire = {
    kind: c.kind,
    detail: c.detail,
  };
  if (c.kind === "drained-with-persist-failure") {
    return { ...base, error: c.error };
  }
  if (c.kind === "link-failed") {
    return base;
  }
  // Framework ConvergenceAnomaly arms carry running / expected / keys.
  if ("running" in c && c.running !== undefined && c.running !== null) {
    const running = c.running;
    base.running = {
      contractVersion: running.contractVersion,
      build:
        running.build.kind === "known"
          ? { kind: "known", id: running.build.id }
          : { kind: "off-nix" },
    };
  }
  if ("expected" in c && c.expected !== undefined && c.expected !== null) {
    const expected = c.expected;
    base.expected = {
      contractVersion: expected.contractVersion,
      build:
        expected.build.kind === "known"
          ? { kind: "known", id: expected.build.id }
          : { kind: "off-nix" },
    };
  }
  if ("drained" in c && c.drained !== undefined) {
    const d = c.drained as
      | { kind: "instance"; key: string | number }
      | { kind: "pre-instance" }
      | string;
    // InstanceKey may be branded string or structured depending on kolu pin.
    if (typeof d === "string") {
      base.drained = { kind: "instance", key: d };
    } else if (d.kind === "instance") {
      base.drained = { kind: "instance", key: d.key };
    } else {
      base.drained = { kind: "pre-instance" };
    }
  }
  if ("observed" in c && c.observed !== undefined) {
    const o = c.observed as
      | { kind: "instance"; key: string | number }
      | { kind: "pre-instance" }
      | string;
    if (typeof o === "string") {
      base.observed = { kind: "instance", key: o };
    } else if (o.kind === "instance") {
      base.observed = { kind: "instance", key: o.key };
    } else {
      base.observed = { kind: "pre-instance" };
    }
  }
  return base;
}

export function projectOutcome(
  o: HostSessionOutcome | null,
): HostOutcomeWire | null {
  if (o === null) return null;
  switch (o.kind) {
    case "replaced":
      return { kind: "replaced", axis: o.axis };
    case "refused":
      return { kind: "refused", anomalyKind: o.anomalyKind };
    case "adopted":
      return { kind: "adopted" };
    case "adopted-stale":
      return { kind: "adopted-stale", anomalyKind: o.anomalyKind };
    case "resolve-failed":
      return { kind: "resolve-failed", resolutionKind: o.resolutionKind };
    default: {
      const _e: never = o;
      return _e;
    }
  }
}

export function projectDaemonStatus(session: {
  convergence: () => DrishtiConvergence | null;
  outcome: () => HostSessionOutcome | null;
  identity: () => DaemonIdentity | null;
  currentState: () => { phase: string };
}): DaemonStatus {
  const c = session.convergence();
  return {
    anomaly: c === null ? null : projectConvergenceAnomaly(c),
    outcome: projectOutcome(session.outcome()),
    identity: session.identity(),
    phase: session.currentState().phase,
  };
}

/** Empty status for unknown/missing host. */
export function emptyDaemonStatus(phase = "unknown"): DaemonStatus {
  return {
    anomaly: null,
    outcome: null,
    identity: null,
    phase,
  };
}

/** Type pin: HostSession must expose identity() for the projection. */
export type SessionWithDaemonStatus = Pick<
  HostSession,
  "convergence" | "outcome" | "currentState"
> & {
  identity: () => DaemonIdentity | null;
};
