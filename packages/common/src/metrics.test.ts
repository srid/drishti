import { describe, expect, it } from "bun:test";
import { averageCoreUsage } from "./metrics";

describe("averageCoreUsage", () => {
  it("averages the per-core usages", () => {
    expect(averageCoreUsage([10, 20, 30, 40])).toBe(25);
  });

  it("returns 0 for no cores (never NaN)", () => {
    expect(averageCoreUsage([])).toBe(0);
  });
});
