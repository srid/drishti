import { describe, expect, it } from "bun:test";
import type { MetricSample, SystemInfo } from "drishti-common";
import {
  captureSample,
  CHART_MAX_POINTS,
  downsample,
  HISTORY_RETENTION_MS,
  HISTORY_WINDOWS,
  isHistoryWindowKey,
  polylinePoints,
  pushSample,
  SPARKLINE_MAX_POINTS,
  WIDEST_HISTORY_WINDOW,
  windowMsFor,
  windowSlice,
} from "./history";

function sample(t: number, cpu = 0, mem = 0, disk = 0, swap = 0): MetricSample {
  return { t, cpu, mem, swap, disk };
}

function sys(over: Partial<SystemInfo> = {}): SystemInfo {
  return {
    loadAvg: [0, 0, 0],
    cpuPct: 0,
    coreCount: 0,
    memUsed: 0,
    memTotal: 0,
    swapUsed: 0,
    swapTotal: 0,
    diskUsed: 0,
    diskTotal: 0,
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

  it("names the widest window as the fleet card's pinned span", () => {
    const widest = HISTORY_WINDOWS.reduce((a, b) => (b.ms > a.ms ? b : a));
    expect(WIDEST_HISTORY_WINDOW).toBe(widest.key);
    expect(windowMsFor(WIDEST_HISTORY_WINDOW)).toBe(HISTORY_RETENTION_MS);
  });
});

describe("windowMsFor", () => {
  it("resolves a known key to its span", () => {
    expect(windowMsFor("1m")).toBe(60_000);
    expect(windowMsFor("15m")).toBe(15 * 60_000);
  });
});

describe("isHistoryWindowKey", () => {
  it("accepts every selectable window key", () => {
    for (const w of HISTORY_WINDOWS) expect(isHistoryWindowKey(w.key)).toBe(true);
  });

  it("rejects unknown or stale keys", () => {
    expect(isHistoryWindowKey("2h")).toBe(false);
    expect(isHistoryWindowKey("")).toBe(false);
  });
});

describe("captureSample", () => {
  it("reads cpu from system.cpuPct and computes memory + swap + disk %", () => {
    const s = captureSample(
      5000,
      sys({
        cpuPct: 25,
        memUsed: 4e9,
        memTotal: 16e9,
        swapUsed: 1e9,
        swapTotal: 2e9,
        diskUsed: 75e9,
        diskTotal: 100e9,
      }),
    );
    expect(s).toEqual({ t: 5000, cpu: 25, mem: 25, swap: 50, disk: 75 });
  });

  it("carries the agent's cpuPct through verbatim (no re-derivation)", () => {
    expect(captureSample(0, sys({ cpuPct: 73.5 })).cpu).toBe(73.5);
  });

  it("yields 0 disk for a host reporting no disk total (never NaN)", () => {
    expect(captureSample(0, sys()).disk).toBe(0);
  });
});

describe("downsample", () => {
  const series = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("is a no-op when already within budget", () => {
    const s = series(50);
    expect(downsample(s, 120)).toBe(s);
    expect(downsample(s, 50)).toBe(s);
  });

  it("caps to maxPoints, keeping the first and last sample", () => {
    const out = downsample(series(900), 120);
    expect(out.length).toBe(120);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(899);
  });

  it("returns evenly-spaced, monotonically non-decreasing indices", () => {
    const out = downsample(series(900), 120) as number[];
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!);
    }
  });

  it("keeps only the newest sample for a budget of 1", () => {
    expect(downsample(series(900), 1)).toEqual([899]);
  });

  it("the configured budgets are well below the 30m ring (900 @ 2s)", () => {
    expect(SPARKLINE_MAX_POINTS).toBeLessThan(900);
    expect(CHART_MAX_POINTS).toBeLessThan(900);
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
