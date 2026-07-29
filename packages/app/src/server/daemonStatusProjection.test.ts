import { describe, expect, it } from "bun:test";
import {
  emptyDaemonStatus,
  projectConvergenceAnomaly,
  projectDaemonStatus,
  projectOutcome,
} from "./daemonStatusProjection";
import type { DrishtiConvergence, HostSessionOutcome } from "./hostRegistry";

describe("projectConvergenceAnomaly", () => {
  it("maps drained-with-persist-failure error field", () => {
    const c: DrishtiConvergence = {
      kind: "drained-with-persist-failure",
      detail: "flush",
      error: "EACCES",
    };
    expect(projectConvergenceAnomaly(c)).toEqual({
      kind: "drained-with-persist-failure",
      detail: "flush",
      error: "EACCES",
    });
  });

  it("maps adopted-stale running/expected builds", () => {
    const c: DrishtiConvergence = {
      kind: "adopted-stale",
      detail: "budget",
      running: {
        contractVersion: "1.0",
        build: { kind: "known", id: "old" },
      },
      expected: {
        contractVersion: "1.0",
        build: { kind: "known", id: "new" },
      },
    };
    const p = projectConvergenceAnomaly(c);
    expect(p.running?.build).toEqual({ kind: "known", id: "old" });
    expect(p.expected?.build).toEqual({ kind: "known", id: "new" });
  });

  it("maps cross-supervisor instance keys", () => {
    const c: DrishtiConvergence = {
      kind: "cross-supervisor",
      detail: "foreign",
      drained: { kind: "instance", key: 11 },
      observed: { kind: "pre-instance" },
      running: {
        contractVersion: "1.0",
        build: { kind: "off-nix" },
      },
    };
    const p = projectConvergenceAnomaly(c);
    expect(p.drained).toEqual({ kind: "instance", key: 11 });
    expect(p.observed).toEqual({ kind: "pre-instance" });
  });
});

describe("projectOutcome", () => {
  it("projects replaced axis", () => {
    const o: HostSessionOutcome = { kind: "replaced", axis: "contract" };
    expect(projectOutcome(o)).toEqual({ kind: "replaced", axis: "contract" });
  });
});

describe("projectDaemonStatus", () => {
  it("composes anomaly + outcome + identity + phase", () => {
    const status = projectDaemonStatus({
      convergence: () => ({
        kind: "link-failed",
        detail: "ssh died",
      }),
      outcome: () => ({ kind: "adopted" }),
      identity: () => ({
        stateRoot: "/s",
        contractVersion: "1.0",
        startedAt: 42,
        commit: "deadbee",
        buildId: "b1",
      }),
      currentState: () => ({ phase: "failed" }),
    });
    expect(status.phase).toBe("failed");
    expect(status.anomaly?.kind).toBe("link-failed");
    expect(status.outcome).toEqual({ kind: "adopted" });
    expect(status.identity?.buildId).toBe("b1");
  });

  it("emptyDaemonStatus is honest nulls", () => {
    expect(emptyDaemonStatus()).toEqual({
      anomaly: null,
      outcome: null,
      identity: null,
      phase: "unknown",
    });
  });
});
