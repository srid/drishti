/**
 * Wave parent-side proofs: W2.6 fail-fast, W2.7 production policy shape.
 */
import { describe, expect, it } from "bun:test";
import {
  drishtiAgentConvergencePolicy,
  expectProvisionedBuildId,
} from "./hostRegistry";

describe("W2.6 provisioned build-id fail-fast", () => {
  it("throws when provisioning with empty BUILD_IDS map", () => {
    expect(() =>
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: {},
        fallbackBuildId: "parent-arch",
        provisioning: true,
      }),
    ).toThrow(/BUILD_IDS map is empty/);
  });

  it("throws when drv map is present but system id is missing", () => {
    expect(() =>
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: { "aarch64-linux": "abc" },
        fallbackBuildId: "",
        provisioning: true,
      }),
    ).toThrow(/missing BUILD_ID for system/);
  });

  it("returns the per-system id when present", () => {
    expect(
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: { "x86_64-linux": "build-xyz" },
        fallbackBuildId: "",
        provisioning: true,
      }),
    ).toBe("build-xyz");
  });

  it("off-nix path (not provisioning) keeps empty can't-judge id", () => {
    expect(
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: {},
        fallbackBuildId: "",
        provisioning: false,
      }),
    ).toBe("");
  });

  it("off-nix path with env fallback uses fallback", () => {
    expect(
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: {},
        fallbackBuildId: "from-env",
        provisioning: false,
      }),
    ).toBe("from-env");
  });
});

describe("W2.1 production policy object", () => {
  it("drishtiAgentConvergencePolicy is the drain-and-replace build arm", () => {
    const p = drishtiAgentConvergencePolicy("id-x");
    expect(p.onBuildMismatch).toEqual({ kind: "drain-and-replace" });
    expect(p.onContractSkew).toEqual({ kind: "drain-newer-else-refuse" });
    expect(p.drainBudget.onGiveUp).toBe("adopt-stale");
  });
});
