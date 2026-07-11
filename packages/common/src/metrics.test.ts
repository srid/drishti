import { describe, expect, it } from "bun:test";
import { averageCoreUsage, metricPercents } from "./metrics";
import { DEFAULT_SYSTEM, type SystemInfo } from "./surface";

describe("averageCoreUsage", () => {
  it("averages the per-core usages", () => {
    expect(averageCoreUsage([10, 20, 30, 40])).toBe(25);
  });

  it("returns 0 for no cores (never NaN)", () => {
    expect(averageCoreUsage([])).toBe(0);
  });
});

describe("metricPercents", () => {
  it("reads cpuPct directly and derives mem/disk as guarded shares", () => {
    const system: SystemInfo = {
      ...DEFAULT_SYSTEM,
      cpuPct: 42,
      memUsed: 8,
      memTotal: 16,
      diskUsed: 30,
      diskTotal: 120,
    };
    expect(metricPercents(system)).toEqual({ cpu: 42, mem: 50, disk: 25 });
  });

  it("guards against a zero total (never NaN)", () => {
    expect(metricPercents(DEFAULT_SYSTEM)).toEqual({ cpu: 0, mem: 0, disk: 0 });
  });
});
