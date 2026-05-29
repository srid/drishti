import { describe, expect, it } from "bun:test";
import type { NetInterface } from "../common/surface";
import { isActiveNic } from "./nic";

describe("isActiveNic", () => {
  const nic = (over: Partial<NetInterface> = {}): NetInterface => ({
    rxBytes: 0,
    txBytes: 0,
    rxRate: 0,
    txRate: 0,
    ...over,
  });

  it("is inactive when both rates are zero", () => {
    expect(isActiveNic(nic())).toBe(false);
  });

  it("is active on receive throughput", () => {
    expect(isActiveNic(nic({ rxRate: 1 }))).toBe(true);
  });

  it("is active on transmit throughput", () => {
    expect(isActiveNic(nic({ txRate: 1 }))).toBe(true);
  });

  it("is inactive for a missing NIC (mid-tick churn)", () => {
    expect(isActiveNic(undefined)).toBe(false);
  });

  it("ignores cumulative byte totals — only live rates count", () => {
    expect(isActiveNic(nic({ rxBytes: 1e9, txBytes: 1e9 }))).toBe(false);
  });
});
