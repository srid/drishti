import { describe, expect, it } from "bun:test";
import {
  type ArmingConfig,
  compareReleaseTags,
  isPreviousReleaseArmed,
  resolvePreviousRelease,
  type TagSource,
} from "./previousRelease";

const stores: Record<string, string> = {
  "v0.1.0": "/nix/store/prev-agent-v010",
  "v0.2.0": "/nix/store/prev-agent-v020",
  "v1.0.0": "/nix/store/cur-agent-v100",
  "v2.0.0": "/nix/store/v2",
  "v1.0.0-alt": "/nix/store/v1",
  "v0.0.0": "/nix/store/v0",
};

const tagSource: TagSource = {
  tags: ["v1.0.0", "v0.2.0", "v0.1.0"],
  storeForTag: (t) => stores[t] ?? null,
};

describe("resolvePreviousRelease (W4.8)", () => {
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
      currentTag: "v1.0.0",
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
        currentTag: "v1.0.0",
        previousTag: "v0.1.0",
      }),
    ).toThrow(/collapsed|equals current/);
  });

  it("armed: [v2.0.0,v1.0.0,v0.0.0] current v2.0.0 ⇒ previous v1.0.0 (ordering)", () => {
    // Round-4 counterexample: first-unequal to arming would pick wrong tag.
    const arming: ArmingConfig = {
      firstDaemonCapableReleaseTag: "v1.0.0",
    };
    const r = resolvePreviousRelease({
      arming,
      tags: {
        tags: ["v2.0.0", "v1.0.0", "v0.0.0"],
        storeForTag: (t) =>
          t === "v2.0.0"
            ? "/nix/store/v2"
            : t === "v1.0.0"
              ? "/nix/store/v1"
              : t === "v0.0.0"
                ? "/nix/store/v0"
                : null,
      },
      currentStore: "/nix/store/cur-v2",
      currentTag: "v2.0.0",
    });
    expect(r.kind).toBe("armed");
    if (r.kind === "armed") {
      expect(r.window.ref).toBe("v1.0.0");
      expect(r.window.previousStore).toBe("/nix/store/v1");
    }
  });

  it("armed: [v2,v0,v1] current v2 ⇒ previous v1 (adjacency trap W5.7)", () => {
    const arming: ArmingConfig = {
      firstDaemonCapableReleaseTag: "v1.0.0",
    };
    const r = resolvePreviousRelease({
      arming,
      tags: {
        tags: ["v2.0.0", "v0.0.0", "v1.0.0"],
        storeForTag: (tag) =>
          tag === "v2.0.0"
            ? "/nix/store/v2"
            : tag === "v1.0.0"
              ? "/nix/store/v1"
              : "/nix/store/v0",
      },
      currentStore: "/nix/store/cur",
      currentTag: "v2.0.0",
    });
    expect(r.kind).toBe("armed");
    if (r.kind === "armed") {
      expect(r.window.ref).toBe("v1.0.0");
    }
  });

  it("armed: explicit previousTag must be strictly older than currentTag", () => {
    const arming: ArmingConfig = {
      firstDaemonCapableReleaseTag: "v1.0.0",
    };
    expect(() =>
      resolvePreviousRelease({
        arming,
        tags: tagSource,
        currentStore: "/nix/store/cur",
        currentTag: "v1.0.0",
        previousTag: "v2.0.0",
      }),
    ).toThrow(/strictly older/);
  });

  it("compareReleaseTags orders semver-like tags", () => {
    expect(compareReleaseTags("v1.0.0", "v2.0.0")).toBeLessThan(0);
    expect(compareReleaseTags("v2.0.0", "v1.0.0")).toBeGreaterThan(0);
    expect(compareReleaseTags("v1.0.0", "v0.2.0")).toBeGreaterThan(0);
  });

  it("armed: ordering pin — first-unequal-to-arming is NOT previous", () => {
    // Newest-first [v2,v1,v0], current v2 → previous v1.
    // Broken "first tag !== armedAt" with armedAt=v1 would select v2.
    const arming: ArmingConfig = {
      firstDaemonCapableReleaseTag: "v1.0.0",
    };
    const r = resolvePreviousRelease({
      arming,
      tags: {
        tags: ["v2.0.0", "v1.0.0", "v0.0.0"],
        storeForTag: (t) =>
          t === "v2.0.0"
            ? "/nix/store/v2"
            : t === "v1.0.0"
              ? "/nix/store/v1"
              : "/nix/store/v0",
      },
      currentStore: "/nix/store/cur",
      currentTag: "v2.0.0",
    });
    expect(r.kind).toBe("armed");
    if (r.kind === "armed") {
      expect(r.window.ref).not.toBe("v2.0.0");
      expect(r.window.ref).toBe("v1.0.0");
    }
  });
});
