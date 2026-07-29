import { describe, expect, it } from "bun:test";
import {
  type ArmingConfig,
  isPreviousReleaseArmed,
  resolvePreviousRelease,
  type TagSource,
} from "./previousRelease";

const stores: Record<string, string> = {
  "v0.1.0": "/nix/store/prev-agent-v010",
  "v0.2.0": "/nix/store/prev-agent-v020",
  "v1.0.0": "/nix/store/cur-agent-v100",
};

const tagSource: TagSource = {
  tags: ["v1.0.0", "v0.2.0", "v0.1.0"],
  storeForTag: (t) => stores[t] ?? null,
};

describe("resolvePreviousRelease (W3.5)", () => {
  it("pre-arming: null arming tag ⇒ synthetic-unarmed", () => {
    const arming: ArmingConfig = { firstDaemonCapableReleaseTag: null };
    expect(isPreviousReleaseArmed(arming)).toBe(false);
    const r = resolvePreviousRelease({
      arming,
      tags: tagSource,
      currentStore: "/nix/store/cur",
    });
    expect(r.kind).toBe("synthetic-unarmed");
  });

  it("armed: resolves previous tag/store from the tag source", () => {
    const arming: ArmingConfig = {
      firstDaemonCapableReleaseTag: "v1.0.0",
    };
    expect(isPreviousReleaseArmed(arming)).toBe(true);
    const r = resolvePreviousRelease({
      arming,
      tags: tagSource,
      currentStore: "/nix/store/cur-agent-v100-new",
      previousTag: "v0.2.0",
    });
    expect(r.kind).toBe("armed");
    if (r.kind === "armed") {
      expect(r.window.ref).toBe("v0.2.0");
      expect(r.window.previousStore).toBe("/nix/store/prev-agent-v020");
      expect(r.window.currentStore).toBe("/nix/store/cur-agent-v100-new");
    }
  });

  it("armed: hard-refuses previous store equals current (via resolvePreviousRelease)", () => {
    const arming: ArmingConfig = {
      firstDaemonCapableReleaseTag: "v1.0.0",
    };
    expect(() =>
      resolvePreviousRelease({
        arming,
        tags: {
          tags: ["v0.1.0"],
          storeForTag: () => "/nix/store/same",
        },
        currentStore: "/nix/store/same",
        previousTag: "v0.1.0",
      }),
    ).toThrow(/collapsed|equals current/);
  });

  it("armed: auto-picks a previous tag from the source when previousTag omitted", () => {
    const arming: ArmingConfig = {
      firstDaemonCapableReleaseTag: "v1.0.0",
    };
    const r = resolvePreviousRelease({
      arming,
      tags: tagSource,
      currentStore: "/nix/store/other",
    });
    expect(r.kind).toBe("armed");
    if (r.kind === "armed") {
      // First tag that isn't only the arming tag alone — finds v0.2.0.
      expect(r.window.previousStore).toBe("/nix/store/prev-agent-v020");
    }
  });
});
