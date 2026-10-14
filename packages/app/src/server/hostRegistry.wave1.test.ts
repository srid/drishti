/**
 * Wave parent-side proofs: W2.1 production policy shape.
 *
 * The W2.6 per-system build-id fail-fast tests that used to live here are gone
 * with the mechanism they pinned: the agent identity is platform-independent
 * now (one value, so no per-system selection to refuse), and its non-emptiness
 * is enforced where the pool is built.
 */
import { describe, expect, it } from "bun:test";
import { drishtiAgentConvergencePolicy } from "./hostRegistry";

describe("W2.1 production policy object", () => {
  it("drishtiAgentConvergencePolicy is the drain-and-replace build arm", () => {
    const p = drishtiAgentConvergencePolicy("id-x");
    expect(p.onBuildMismatch).toEqual({ kind: "drain-and-replace" });
    expect(p.onContractSkew).toEqual({ kind: "drain-newer-else-refuse" });
    expect(p.drainBudget.onGiveUp).toBe("adopt-stale");
  });
});
