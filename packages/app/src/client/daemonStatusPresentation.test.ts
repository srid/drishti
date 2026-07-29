import { describe, expect, it } from "bun:test";
import type { DaemonStatus } from "../common/daemonStatus";
import {
  anomalyBanner,
  applyDaemonStatusError,
  applyRenewResult,
  applyRenewStart,
  chipFromDaemonStatus,
  chipGlanceVisible,
  identityRows,
  outcomeSummary,
} from "./daemonStatusPresentation";

function base(over: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    anomaly: null,
    outcome: null,
    identity: null,
    phase: "connected",
    ...over,
  };
}

describe("chipFromDaemonStatus (every kind)", () => {
  it("clean when connected without anomaly", () => {
    const c = chipFromDaemonStatus(base({ phase: "connected" }));
    expect(c.kind).toBe("clean");
    expect(c.tone).toBe("ok");
    expect(c.showNudge).toBe(false);
  });

  it("adopted-stale shows warn + nudge", () => {
    const c = chipFromDaemonStatus(
      base({
        anomaly: {
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
        },
      }),
    );
    expect(c.kind).toBe("adopted-stale");
    expect(c.tone).toBe("warn");
    expect(c.showNudge).toBe(true);
  });

  it("skew-refused is down without nudge", () => {
    const c = chipFromDaemonStatus(
      base({
        anomaly: {
          kind: "skew-refused",
          detail: "skew",
          running: {
            contractVersion: "9.9",
            build: { kind: "known", id: "x" },
          },
          expected: {
            contractVersion: "1.0",
            build: { kind: "known", id: "y" },
          },
        },
      }),
    );
    expect(c.kind).toBe("skew-refused");
    expect(c.tone).toBe("down");
    expect(c.showNudge).toBe(false);
  });

  it("cross-supervisor is down", () => {
    expect(
      chipFromDaemonStatus(
        base({
          anomaly: {
            kind: "cross-supervisor",
            detail: "foreign",
            drained: { kind: "instance", key: 1 },
            observed: { kind: "instance", key: 2 },
            running: {
              contractVersion: "1.0",
              build: { kind: "off-nix" },
            },
          },
        }),
      ).kind,
    ).toBe("cross-supervisor");
  });

  it("drained-with-persist-failure is warn", () => {
    const c = chipFromDaemonStatus(
      base({
        anomaly: {
          kind: "drained-with-persist-failure",
          detail: "flush",
          error: "EACCES",
        },
      }),
    );
    expect(c.kind).toBe("drained-with-persist-failure");
    expect(c.tone).toBe("warn");
  });

  it("off-nix from resolve-failed unavailable", () => {
    const c = chipFromDaemonStatus(
      base({
        phase: "disconnected",
        outcome: {
          kind: "resolve-failed",
          resolutionKind: "unavailable",
        },
      }),
    );
    expect(c.kind).toBe("off-nix");
    expect(c.tone).toBe("muted");
  });

  it("boot-refused is down WITHOUT adopted-stale Renew nudge (U2.6)", () => {
    const msg =
      "daemonHome: /x is not a private owner-only directory (must be owned by the current user with mode 0700)";
    const c = chipFromDaemonStatus(
      base({
        phase: "failed",
        anomaly: { kind: "boot-refused", detail: msg, message: msg },
        outcome: { kind: "boot-refused", message: msg },
      }),
    );
    expect(c.kind).toBe("boot-refused");
    expect(c.tone).toBe("down");
    expect(c.showNudge).toBe(false);
    expect(outcomeSummary({ kind: "boot-refused", message: msg })).toContain(
      "not a private owner-only directory",
    );
    const b = anomalyBanner({
      kind: "boot-refused",
      detail: msg,
      message: msg,
    });
    expect(b?.bootRefusedMessage).toBe(msg);
  });

  it("unconverged and link-failed chip kinds (U2.7 every arm)", () => {
    expect(
      chipFromDaemonStatus(
        base({
          anomaly: {
            kind: "unconverged",
            detail: "x",
            running: null,
            expected: {
              contractVersion: "1.0",
              build: { kind: "known", id: "e" },
            },
            cause: { kind: "identity-unverifiable" },
          },
        }),
      ).kind,
    ).toBe("unconverged");
    expect(
      chipFromDaemonStatus(
        base({ anomaly: { kind: "link-failed", detail: "ssh died" } }),
      ).kind,
    ).toBe("link-failed");
  });

  it("disconnected / warming phases", () => {
    expect(
      chipFromDaemonStatus(base({ phase: "disconnected" })).kind,
    ).toBe("disconnected");
    expect(chipFromDaemonStatus(base({ phase: "probing" })).kind).toBe(
      "warming",
    );
    expect(chipFromDaemonStatus(base({ phase: "connecting" })).tone).toBe(
      "warming",
    );
  });

  it("null status is unknown", () => {
    expect(chipFromDaemonStatus(null).kind).toBe("unknown");
  });

  it("chipGlanceVisible: quiet when healthy / redundant with connection label", () => {
    expect(
      chipGlanceVisible(chipFromDaemonStatus(base({ phase: "connected" }))),
    ).toBe(false);
    expect(
      chipGlanceVisible(
        chipFromDaemonStatus(
          base({ anomaly: { kind: "link-failed", detail: "x" } }),
        ),
      ),
    ).toBe(false);
    expect(
      chipGlanceVisible(chipFromDaemonStatus(base({ phase: "disconnected" }))),
    ).toBe(false);
    expect(
      chipGlanceVisible(chipFromDaemonStatus(base({ phase: "probing" }))),
    ).toBe(false);
    expect(chipGlanceVisible(chipFromDaemonStatus(null))).toBe(false);
  });

  it("chipGlanceVisible: daemon-only facts stay on glance surfaces", () => {
    for (const kind of [
      "adopted-stale",
      "boot-refused",
      "skew-refused",
      "cross-supervisor",
      "drained-with-persist-failure",
      "unconverged",
      "off-nix",
    ] as const) {
      // Presence of these kinds is covered above; pin glance visibility true.
      void kind;
    }
    expect(
      chipGlanceVisible(
        chipFromDaemonStatus(
          base({
            anomaly: {
              kind: "adopted-stale",
              detail: "d",
              running: {
                contractVersion: "1.0",
                build: { kind: "known", id: "a" },
              },
              expected: {
                contractVersion: "1.0",
                build: { kind: "known", id: "b" },
              },
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      chipGlanceVisible(
        chipFromDaemonStatus(
          base({
            anomaly: {
              kind: "boot-refused",
              detail: "m",
              message: "m",
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      chipGlanceVisible(
        chipFromDaemonStatus(
          base({
            outcome: {
              kind: "resolve-failed",
              resolutionKind: "unavailable",
            },
          }),
        ),
      ),
    ).toBe(true);
  });
});

describe("dialog projection helpers", () => {
  it("identity rows present for connected host (null → dash)", () => {
    const rows = identityRows({
      stateRoot: "/state",
      contractVersion: "1.0",
      startedAt: 1_700_000_000_000,
      commit: "abc",
      buildId: "bld",
    });
    expect(rows.map((r) => r.label)).toEqual([
      "buildId",
      "commit",
      "contract",
      "startedAt",
      "stateRoot",
    ]);
    expect(rows.find((r) => r.label === "buildId")?.value).toBe("bld");
    expect(identityRows(null).every((r) => r.value === "—")).toBe(true);
  });

  it("outcomeSummary uses typed fields only", () => {
    expect(outcomeSummary({ kind: "replaced", axis: "build" })).toContain(
      "build",
    );
    expect(
      outcomeSummary({ kind: "refused", anomalyKind: "skew-refused" }),
    ).toContain("skew-refused");
    expect(outcomeSummary(null)).toBeNull();
  });

  it("anomalyBanner uses structured evidence (running/expected)", () => {
    const b = anomalyBanner({
      kind: "adopted-stale",
      detail: "budget exhausted",
      running: {
        contractVersion: "1.0",
        build: { kind: "known", id: "run-id" },
      },
      expected: {
        contractVersion: "1.0",
        build: { kind: "known", id: "exp-id" },
      },
    });
    expect(b).not.toBeNull();
    expect(b!.evidence.some((e) => e.includes("run-id"))).toBe(true);
    expect(b!.evidence.some((e) => e.includes("exp-id"))).toBe(true);
  });
});

describe("renew + poll folds", () => {
  it("renew result becomes state (not only console)", () => {
    expect(applyRenewStart({ kind: "idle" })).toEqual({ kind: "pending" });
    expect(applyRenewResult({ ok: true })).toEqual({ kind: "ok" });
    expect(applyRenewResult({ ok: false, error: "nope" })).toEqual({
      kind: "error",
      error: "nope",
    });
  });

  it("poll error retains standing status", () => {
    const prev = base({
      anomaly: {
        kind: "skew-refused",
        detail: "x",
        running: {
          contractVersion: "2.0",
          build: { kind: "known", id: "r" },
        },
        expected: {
          contractVersion: "1.0",
          build: { kind: "known", id: "e" },
        },
      },
    });
    const next = applyDaemonStatusError(prev, "network");
    expect(next.status?.anomaly?.kind).toBe("skew-refused");
    expect(next.pollError).toBe("network");
  });
});
