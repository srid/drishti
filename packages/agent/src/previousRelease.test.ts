import { describe, expect, it } from "bun:test";
import { assertPreviousReleaseWindow } from "@kolu/surface-daemon/upgrade-window.testlib";
import {
  FIRST_DAEMON_CAPABLE_RELEASE_TAG,
  isPreviousReleaseArmed,
  resolvePreviousRelease,
} from "./previousRelease";

describe("previous-release resolver (W2.3)", () => {
  it("pre-arming: FIRST_DAEMON_CAPABLE_RELEASE_TAG is null ⇒ synthetic-unarmed", () => {
    expect(FIRST_DAEMON_CAPABLE_RELEASE_TAG).toBeNull();
    expect(isPreviousReleaseArmed()).toBe(false);
    const r = resolvePreviousRelease({
      previousTag: "v0.1.0",
      previousStore: "/nix/store/aaa-drishti-agent",
      currentStore: "/nix/store/bbb-drishti-agent",
    });
    expect(r.kind).toBe("synthetic-unarmed");
    if (r.kind === "synthetic-unarmed") {
      expect(r.reason).toMatch(/synthetic previous|FIRST_DAEMON_CAPABLE/);
    }
  });

  it("equal-refusal: previous store equals current throws", () => {
    // The hard refusal the armed arm invokes (framework gate).
    expect(() =>
      assertPreviousReleaseWindow({
        ref: "v0.1.0",
        previousStore: "/nix/store/same",
        currentStore: "/nix/store/same",
      }),
    ).toThrow(/collapsed|equals current/);
  });

  it("armed path is gated until FIRST_DAEMON_CAPABLE_RELEASE_TAG is set", () => {
    if (!isPreviousReleaseArmed()) {
      expect(
        resolvePreviousRelease({
          previousTag: null,
          previousStore: null,
          currentStore: "/nix/store/cur",
        }).kind,
      ).toBe("synthetic-unarmed");
      return;
    }
    const r = resolvePreviousRelease({
      previousTag: FIRST_DAEMON_CAPABLE_RELEASE_TAG!,
      previousStore: "/nix/store/prev-agent",
      currentStore: "/nix/store/cur-agent",
    });
    expect(r.kind).toBe("armed");
  });
});
