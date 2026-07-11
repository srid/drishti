import { describe, expect, it } from "bun:test";
import {
  type Alerts,
  applyHysteresis,
  alertsEqual,
  type MetricsFrame,
  NO_ALERTS,
} from "./alerts";

const frame = (over: Partial<MetricsFrame>): MetricsFrame => ({
  cpu: 0,
  mem: 0,
  disk: 0,
  ...over,
});

describe("applyHysteresis", () => {
  it("raises a metric at the 80% threshold", () => {
    const next = applyHysteresis(NO_ALERTS, frame({ cpu: 80 }));
    expect(next.items).toEqual(["cpu"]);
  });

  it("does not raise just below the threshold", () => {
    const next = applyHysteresis(NO_ALERTS, frame({ cpu: 79.9 }));
    expect(next.items).toEqual([]);
  });

  it("holds by returning the PREV reference in the 70-80 dead band", () => {
    const raised = applyHysteresis(NO_ALERTS, frame({ cpu: 85 }));
    // Falls into the dead band (>=70, <80): an already-raised alert stays
    // raised, and — crucially — the SAME reference comes back so `scan`
    // publishes nothing.
    const held = applyHysteresis(raised, frame({ cpu: 75 }));
    expect(held).toBe(raised);
  });

  it("holds (prev reference) when an un-raised metric sits in the dead band", () => {
    const held = applyHysteresis(NO_ALERTS, frame({ cpu: 75 }));
    expect(held).toBe(NO_ALERTS);
  });

  it("clears only once the metric falls below 70%", () => {
    const raised = applyHysteresis(NO_ALERTS, frame({ cpu: 90 }));
    // 70 is still in the dead band — held.
    expect(applyHysteresis(raised, frame({ cpu: 70 }))).toBe(raised);
    // Below 70 clears.
    const cleared = applyHysteresis(raised, frame({ cpu: 69 }));
    expect(cleared.items).toEqual([]);
  });

  it("tracks each metric independently", () => {
    let state: Alerts = NO_ALERTS;
    state = applyHysteresis(state, frame({ cpu: 95, mem: 10, disk: 10 }));
    expect(state.items).toEqual(["cpu"]);

    // Raise mem and disk while cpu stays high; ids stay in metric order.
    state = applyHysteresis(state, frame({ cpu: 95, mem: 88, disk: 82 }));
    expect(state.items).toEqual(["cpu", "mem", "disk"]);

    // Drop cpu below the clear edge; mem/disk remain raised.
    state = applyHysteresis(state, frame({ cpu: 20, mem: 88, disk: 82 }));
    expect(state.items).toEqual(["mem", "disk"]);
  });
});

describe("alertsEqual", () => {
  it("equal iff the same set of ids is raised", () => {
    const a: Alerts = { items: ["cpu"] };
    const b: Alerts = { items: ["cpu"] };
    expect(alertsEqual(a, b)).toBe(true);

    const c: Alerts = { items: ["mem"] };
    expect(alertsEqual(a, c)).toBe(false);
    expect(alertsEqual(a, NO_ALERTS)).toBe(false);
  });
});
