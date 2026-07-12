import { describe, expect, it } from "bun:test";
import { averageCoreUsage, metricPercents, swapPct } from "./metrics";
import { DEFAULT_SYSTEM, type SystemInfo } from "./surface";

describe("averageCoreUsage", () => {
  it("averages the per-core usages", () => {
    expect(averageCoreUsage([10, 20, 30, 40])).toBe(25);
  });

  it("returns 0 for no cores (never NaN)", () => {
    expect(averageCoreUsage([])).toBe(0);
  });
});

describe("swapPct", () => {
  it("derives swap used as a guarded share of total", () => {
    expect(swapPct({ ...DEFAULT_SYSTEM, swapUsed: 1, swapTotal: 4 })).toBe(25);
  });

  it("returns 0 for a swapless host (never NaN)", () => {
    expect(swapPct({ ...DEFAULT_SYSTEM, swapUsed: 0, swapTotal: 0 })).toBe(0);
  });
});

describe("metricPercents", () => {
  it("reads cpuPct directly and derives mem/swap/disk as guarded shares", () => {
    const system: SystemInfo = {
      ...DEFAULT_SYSTEM,
      cpuPct: 42,
      memUsed: 8,
      memTotal: 16,
      swapUsed: 1,
      swapTotal: 4,
      diskUsed: 30,
      diskTotal: 120,
    };
    expect(metricPercents(system)).toEqual({
      cpu: 42,
      mem: 50,
      swap: 25,
      disk: 25,
    });
  });

  it("guards against a zero total (never NaN)", () => {
    expect(metricPercents(DEFAULT_SYSTEM)).toEqual({
      cpu: 0,
      mem: 0,
      swap: 0,
      disk: 0,
    });
  });
});
