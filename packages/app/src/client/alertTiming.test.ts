import { describe, expect, it } from "bun:test";
import { reconcileRaiseTimes } from "./alertTiming";

describe("reconcileRaiseTimes", () => {
  it("stamps a newly-raised key with `now`", () => {
    const next = reconcileRaiseTimes({}, new Set(["h a"]), 1000);
    expect(next).toEqual({ "h a": 1000 });
  });

  it("keeps a still-raised key's ORIGINAL stamp (does not re-stamp)", () => {
    const first = reconcileRaiseTimes({}, new Set(["h a"]), 1000);
    const later = reconcileRaiseTimes(first, new Set(["h a"]), 5000);
    expect(later["h a"]).toBe(1000);
  });

  it("returns the SAME reference when nothing changed (no redundant write)", () => {
    const prev = { "h a": 1000 };
    const next = reconcileRaiseTimes(prev, new Set(["h a"]), 5000);
    expect(next).toBe(prev);
  });

  it("forgets a key that has CLEARED (left the live set)", () => {
    const raised = reconcileRaiseTimes({}, new Set(["h a"]), 1000);
    const cleared = reconcileRaiseTimes(raised, new Set(), 2000);
    expect(cleared).toEqual({});
  });

  it("stamps a re-raise FRESH, never resurrecting the prior time", () => {
    const raised = reconcileRaiseTimes({}, new Set(["h a"]), 1000);
    const cleared = reconcileRaiseTimes(raised, new Set(), 2000);
    const reraised = reconcileRaiseTimes(cleared, new Set(["h a"]), 3000);
    expect(reraised["h a"]).toBe(3000);
  });

  it("tracks multiple keys independently — one clears while another holds", () => {
    let state = reconcileRaiseTimes({}, new Set(["h disk"]), 1000);
    state = reconcileRaiseTimes(state, new Set(["h disk", "h mem"]), 2000);
    expect(state).toEqual({ "h disk": 1000, "h mem": 2000 });
    // disk clears (fell below the hysteresis CLEAR edge); mem holds.
    state = reconcileRaiseTimes(state, new Set(["h mem"]), 3000);
    expect(state).toEqual({ "h mem": 2000 });
  });
});
