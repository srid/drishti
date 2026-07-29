import { describe, expect, it } from "bun:test";
import {
  applyConvergencePollError,
  applyConvergencePollOk,
  convergenceBannerVisible,
  type ConvergencePollState,
} from "./convergenceProjection";

describe("convergenceProjection (W3.4)", () => {
  it("poll ok sets anomaly and clears pollError", () => {
    const prev: ConvergencePollState = {
      anomaly: { kind: "adopted-stale", detail: "old" },
      pollError: "stale error",
    };
    const next = applyConvergencePollOk(prev, {
      kind: "cross-supervisor",
      detail: "foreign",
    });
    expect(next.anomaly?.kind).toBe("cross-supervisor");
    expect(next.pollError).toBeNull();
  });

  it("poll error retains standing anomaly (never catch-to-null)", () => {
    const prev: ConvergencePollState = {
      anomaly: { kind: "skew-refused", detail: "skew" },
      pollError: null,
    };
    const next = applyConvergencePollError(prev, "network down");
    expect(next.anomaly).toEqual({ kind: "skew-refused", detail: "skew" });
    expect(next.pollError).toBe("network down");
  });

  it("banner is visible for any non-null anomaly regardless of phase", () => {
    const a = { kind: "cross-supervisor", detail: "x" };
    expect(convergenceBannerVisible(a, "disconnected")).toBe(true);
    expect(convergenceBannerVisible(a, "failed")).toBe(true);
    expect(convergenceBannerVisible(a, "connected")).toBe(true);
    expect(convergenceBannerVisible(null, "disconnected")).toBe(false);
  });
});
