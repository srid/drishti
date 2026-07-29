import { describe, expect, it } from "bun:test";
import { drishtiAgentConvergencePolicy } from "./hostRegistry";

describe("drishtiAgentConvergencePolicy", () => {
  it("is drainable with the UW3 policy arms and budget", () => {
    const policy = drishtiAgentConvergencePolicy("build-abc");
    expect(policy.capability).toBe("drainable");
    expect(policy.baked.contractVersion).toBe("1.0");
    expect(policy.baked.build).toEqual({ kind: "known", id: "build-abc" });
    expect(policy.onContractSkew).toEqual({ kind: "drain-newer-else-refuse" });
    expect(policy.onBuildMismatch).toEqual({ kind: "drain-and-replace" });
    expect(policy.drainBudget).toEqual({
      maxAttempts: 2,
      onGiveUp: "adopt-stale",
    });
  });

  it("treats an empty binder build id as off-nix (can't judge builds)", () => {
    const policy = drishtiAgentConvergencePolicy("");
    expect(policy.baked.build).toEqual({ kind: "off-nix" });
  });
});
