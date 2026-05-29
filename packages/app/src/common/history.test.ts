import { describe, expect, it } from "bun:test";
import type { MetricSample, SystemInfo } from "./surface";
import {
  captureSample,
  HISTORY_RETENTION_MS,
  HISTORY_WINDOWS,
  polylinePoints,
  pushSample,
  windowMsFor,
  windowSlice,
} from "./history";

function sample(t: number, cpu = 0, mem = 0): MetricSample {
  return { t, cpu, mem };
}

function sys(over: Partial<SystemInfo> = {}): SystemInfo {
  return {
    loadAvg: [0, 0, 0],
    memUsed: 0,
    memTotal: 0,
    uptime: 0,
    os: "linux",
    hostname: "h",
    pollIntervalMs: 1000,
    ...over,
  };
}

describe("HISTORY_WINDOWS", () => {
  it("is ascending by span", () => {
    const spans = HISTORY_WINDOWS.map((w) => w.ms);
    expect(spans).toEqual([...spans].sort((a, b) => a - b));
  });

  it("uses the widest window as the retention bound", () => {
    expect(HISTORY_RETENTION_MS).toBe(
      Math.max(...HISTORY_WINDOWS.map((w) => w.ms)),
    );
  });
});

describe("windowMsFor", () => {
  it("resolves a known key to its span", () => {
    expect(windowMsFor("1m")).toBe(60_000);
    expect(windowMsFor("15m")).toBe(15 * 60_000);
  });
});

describe("captureSample", () => {
  it("averages the per-core usages and computes memory %", () => {
    const s = captureSample(
      5000,
      sys({ memUsed: 4e9, memTotal: 16e9 }),
      [10, 20, 30, 40],
    );
    expect(s).toEqual({ t: 5000, cpu: 25, mem: 25 });
  });

  it("yields 0 cpu for a host reporting no cores (never NaN)", () => {
    expect(captureSample(0, sys(), []).cpu).toBe(0);
  });
});

describe("pushSample", () => {
  it("appends a sample without mutating the input", () => {
    const before: MetricSample[] = [sample(1000)];
    const after = pushSample(before, sample(2000), 60_000);
    expect(after).toHaveLength(2);
    expect(before).toHaveLength(1); // input untouched
  });

  it("evicts samples older than the retention window", () => {
    const buf = [sample(0), sample(1000), sample(5000)];
    // Newest is 10_000; retention 5_000 ⇒ keep t >= 5_000.
    const after = pushSample(buf, sample(10_000), 5_000);
    expect(after.map((s) => s.t)).toEqual([5000, 10_000]);
  });

  it("measures the cutoff from the newest t, not the incoming one (clock blip)", () => {
    const buf = [sample(9000), sample(10_000)];
    // A late/backwards sample at t=500 must not wipe the recent points.
    const after = pushSample(buf, sample(500), 5_000);
    expect(after.map((s) => s.t)).toEqual([9000, 10_000]);
  });
});

describe("windowSlice", () => {
  it("keeps only samples within windowMs of now", () => {
    const buf = [sample(0), sample(4000), sample(8000), sample(10_000)];
    const after = windowSlice(buf, 5_000, 10_000);
    expect(after.map((s) => s.t)).toEqual([8000, 10_000]);
  });
});

describe("polylinePoints", () => {
  it("maps time to x across the window and inverts the metric for y", () => {
    // window [0, 100]: t=50 ⇒ x=50; cpu=40 ⇒ y=60.
    const pts = polylinePoints([sample(50, 40)], "cpu", 100, 100);
    expect(pts).toBe("50.00,60.00");
  });

  it("clamps values above 100% to the top of the band", () => {
    const pts = polylinePoints([sample(100, 150)], "cpu", 100, 100);
    expect(pts).toBe("100.00,0.00");
  });

  it("reads the requested series", () => {
    const pts = polylinePoints([sample(100, 10, 75)], "mem", 100, 100);
    expect(pts).toBe("100.00,25.00");
  });

  it("returns an empty string for no samples", () => {
    expect(polylinePoints([], "cpu", 100, 100)).toBe("");
  });
});
