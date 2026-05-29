import { describe, expect, it } from "bun:test";
import type { SystemInfo } from "../common/surface";
import { averageCoreUsage, formatUptime, memGb, memPct } from "./metrics";

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

describe("memPct", () => {
  it("computes used/total as a percentage", () => {
    expect(memPct(sys({ memUsed: 4e9, memTotal: 16e9 }))).toBe(25);
  });

  it("returns 0 when total is unknown (no divide-by-zero)", () => {
    expect(memPct(sys({ memUsed: 4e9, memTotal: 0 }))).toBe(0);
  });
});

describe("memGb", () => {
  it("formats bytes to one-decimal gigabytes", () => {
    expect(memGb(sys({ memUsed: 4.2e9, memTotal: 16e9 }))).toEqual({
      used: "4.2",
      total: "16.0",
    });
  });
});

describe("formatUptime", () => {
  it("shows days and hours past a day", () => {
    expect(formatUptime(2 * 86400 + 3 * 3600 + 4 * 60)).toBe("2d 3h");
  });

  it("shows hours and minutes under a day", () => {
    expect(formatUptime(5 * 3600 + 12 * 60)).toBe("5h 12m");
  });

  it("shows minutes under an hour", () => {
    expect(formatUptime(42 * 60 + 30)).toBe("42m");
  });
});

describe("averageCoreUsage", () => {
  it("averages the per-core usages", () => {
    expect(averageCoreUsage([10, 20, 30, 40])).toBe(25);
  });

  it("returns 0 for no cores (never NaN)", () => {
    expect(averageCoreUsage([])).toBe(0);
  });
});
