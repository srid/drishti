/**
 * Project HostSession supervision state to the admin wire DaemonStatus.
 * Pure — unit-tested; admin-router is a thin call site.
 *
 * U2.5: closed arm projection — each wire arm's required evidence is set
 * exhaustively (no open optional soup).
 */
import type {
  ConvergenceAnomalyWire,
  DaemonIdentity,
  DaemonStatus,
  HostOutcomeWire,
  SessionPhaseWire,
  UnconvergedCauseWire,
} from "../common/daemonStatus";
import type {
  DrishtiConvergence,
  HostSession,
  HostSessionOutcome,
} from "./hostRegistry";

function projectBuild(
  build: { kind: "known"; id: string } | { kind: "off-nix" },
): { kind: "known"; id: string } | { kind: "off-nix" } {
  return build.kind === "known"
    ? { kind: "known", id: build.id }
    : { kind: "off-nix" };
}

function projectIdentity(id: {
  contractVersion: string;
  build: { kind: "known"; id: string } | { kind: "off-nix" };
}): { contractVersion: string; build: ReturnType<typeof projectBuild> } {
  return {
    contractVersion: id.contractVersion,
    build: projectBuild(id.build),
  };
}

function projectInstanceKey(
  k:
    | { kind: "instance"; key: string | number }
    | { kind: "pre-instance" }
    | string,
):
  | { kind: "instance"; key: string | number }
  | { kind: "pre-instance" } {
  if (typeof k === "string") return { kind: "instance", key: k };
  if (k.kind === "instance") return { kind: "instance", key: k.key };
  return { kind: "pre-instance" };
}

function projectUnconvergedCause(
  cause: Extract<DrishtiConvergence, { kind: "unconverged" }>["cause"],
): UnconvergedCauseWire {
  switch (cause.kind) {
    case "budget-exhausted":
      return {
        kind: "budget-exhausted",
        axis: cause.axis,
        attempts: cause.attempts,
        maxAttempts: cause.maxAttempts,
      };
    case "drain-not-taken":
      return {
        kind: "drain-not-taken",
        axis: cause.axis,
        ceilingMs: cause.ceilingMs,
        rejection: cause.rejection,
      };
    case "adopt-bind-failed":
      return { kind: "adopt-bind-failed", axis: cause.axis };
    case "identity-unverifiable":
      return { kind: "identity-unverifiable" };
    case "probe-failed":
      return { kind: "probe-failed", message: cause.message };
    // PLAN D6 / #3, new with the Effect protocol epoch: the resident daemon
    // speaks the PREVIOUS wire and its first frame is undecodable. Evidence as
    // DATA (the operator needs the pid to stop it out of band) — never prose.
    case "unspeakable-protocol":
      return {
        kind: "unspeakable-protocol",
        socketPath: cause.socketPath,
        gatePath: cause.gatePath,
        pid: cause.pid,
      };
    default: {
      const _e: never = cause;
      throw new Error(
        `projectUnconvergedCause: unreachable ${JSON.stringify(_e)}`,
      );
    }
  }
}

/** Project a standing DrishtiConvergence to typed closed wire (no prose parsing). */
export function projectConvergenceAnomaly(
  c: DrishtiConvergence,
): ConvergenceAnomalyWire {
  switch (c.kind) {
    case "link-failed":
      return { kind: "link-failed", detail: c.detail };
    case "drained-with-persist-failure":
      return {
        kind: "drained-with-persist-failure",
        detail: c.detail,
        error: c.error,
      };
    case "boot-refused":
      return {
        kind: "boot-refused",
        detail: c.detail,
        message: c.message,
      };
    case "adopted-stale":
      return {
        kind: "adopted-stale",
        detail: c.detail,
        running: projectIdentity(c.running),
        expected: projectIdentity(c.expected),
      };
    case "skew-refused":
      return {
        kind: "skew-refused",
        detail: c.detail,
        running: projectIdentity(c.running),
        expected: projectIdentity(c.expected),
      };
    case "unconverged":
      return {
        kind: "unconverged",
        detail: c.detail,
        running: c.running === null ? null : projectIdentity(c.running),
        expected: projectIdentity(c.expected),
        cause: projectUnconvergedCause(c.cause),
      };
    case "cross-supervisor":
      return {
        kind: "cross-supervisor",
        detail: c.detail,
        drained: projectInstanceKey(c.drained),
        observed: projectInstanceKey(c.observed),
        running: projectIdentity(c.running),
      };
    default: {
      const _e: never = c;
      throw new Error(
        `projectConvergenceAnomaly: unreachable ${JSON.stringify(_e)}`,
      );
    }
  }
}

type RefusedKind = Extract<HostOutcomeWire, { kind: "refused" }>["anomalyKind"];
type ResolveKind = Extract<
  HostOutcomeWire,
  { kind: "resolve-failed" }
>["resolutionKind"];

export function projectOutcome(
  o: HostSessionOutcome | null,
): HostOutcomeWire | null {
  if (o === null) return null;
  switch (o.kind) {
    case "replaced":
      return { kind: "replaced", axis: o.axis };
    case "refused":
      return {
        kind: "refused",
        anomalyKind: o.anomalyKind as RefusedKind,
      };
    case "adopted":
      return { kind: "adopted" };
    case "adopted-stale":
      return { kind: "adopted-stale", anomalyKind: "adopted-stale" };
    case "resolve-failed":
      return {
        kind: "resolve-failed",
        resolutionKind: o.resolutionKind as ResolveKind,
      };
    case "boot-refused":
      return { kind: "boot-refused", message: o.message };
    default: {
      const _e: never = o;
      return _e;
    }
  }
}

const KNOWN_PHASES = new Set<SessionPhaseWire>([
  "probing",
  "provisioning",
  "connecting",
  "connected",
  "disconnected",
  "failed",
  "unknown",
]);

function projectPhase(phase: string): SessionPhaseWire {
  return KNOWN_PHASES.has(phase as SessionPhaseWire)
    ? (phase as SessionPhaseWire)
    : "unknown";
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
    phase: projectPhase(session.currentState().phase),
  };
}

/** Empty status for unknown/missing host. */
export function emptyDaemonStatus(
  phase: SessionPhaseWire = "unknown",
): DaemonStatus {
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
