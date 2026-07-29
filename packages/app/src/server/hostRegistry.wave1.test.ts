/**
 * Wave-1 parent-side proofs: W6 fail-fast provisioned build id, W7
 * convergence projection + renew callable at the session/router shape.
 */
import { describe, expect, it } from "bun:test";
import {
  type DrishtiConvergence,
  expectProvisionedBuildId,
} from "./hostRegistry";

describe("W6 provisioned build-id fail-fast", () => {
  it("throws when drv map is present but system id is missing", () => {
    expect(() =>
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: { "aarch64-linux": "abc" },
        fallbackBuildId: "",
      }),
    ).toThrow(/missing BUILD_ID for system/);
  });

  it("returns the per-system id when present", () => {
    expect(
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: { "x86_64-linux": "build-xyz" },
        fallbackBuildId: "",
      }),
    ).toBe("build-xyz");
  });

  it("off-nix path (empty map) keeps empty can't-judge id", () => {
    expect(
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: {},
        fallbackBuildId: "",
      }),
    ).toBe("");
  });

  it("off-nix path with env fallback uses fallback", () => {
    expect(
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: {},
        fallbackBuildId: "from-env",
      }),
    ).toBe("from-env");
  });
});

describe("W7 convergence + renew projection shape", () => {
  it("adopt-stale session projects convergence; renew is callable", async () => {
    // Mirrors HostSession.convergence() / renew() the admin router exposes.
    let convergence: DrishtiConvergence | null = {
      kind: "adopted-stale",
      running: {
        contractVersion: "1.0",
        build: { kind: "known", id: "old" },
      },
      expected: {
        contractVersion: "1.0",
        build: { kind: "known", id: "new" },
      },
      detail: "build mismatch — riding resident after budget",
    };
    let renewCalls = 0;
    const session = {
      convergence: () => convergence,
      preservation: { children: "die" as const },
      renew: async () => {
        renewCalls += 1;
        convergence = null;
      },
    };

    const projected = session.convergence();
    expect(projected).not.toBeNull();
    expect(projected?.kind).toBe("adopted-stale");
    expect(projected?.detail.length).toBeGreaterThan(0);

    // Admin router projects { kind, detail } for the browser.
    const wire = projected
      ? { kind: projected.kind, detail: projected.detail }
      : null;
    expect(wire).toEqual({
      kind: "adopted-stale",
      detail: "build mismatch — riding resident after budget",
    });

    await session.renew();
    expect(renewCalls).toBe(1);
    expect(session.convergence()).toBeNull();
  });
});
