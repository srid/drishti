/**
 * W4 pool construction (discriminated union) + drain persist capture.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directAgentDerivation } from "@kolu/surface-remote";
import { TEST_BINARY_CACHE } from "@kolu/surface-remote/agentDerivation.testutil";
import { ORPCError } from "@orpc/client";
import {
  buildHostPool,
  captureDrainPersistFailure,
  convergenceFromDrainPersistFailure,
  expectProvisionedBuildId,
} from "./hostRegistry";

const fakeResolve = async () => ({
  derivation: directAgentDerivation(
    "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-drishti-agent.drv",
    TEST_BINARY_CACHE,
  ),
  system: "x86_64-linux",
});

describe("buildHostPool discriminated construction (W4.7)", () => {
  it("construction crashes when provisioning without buildIdBySystem", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-w47-"));
    try {
      // Omit buildIdBySystem via cast — runtime still requires non-empty map.
      const bad = {
        initialHosts: [] as const,
        resolveDrvPath: fakeResolve,
        hostsFile: join(dir, "hosts.json"),
      };
      expect(() =>
        buildHostPool(bad as unknown as Parameters<typeof buildHostPool>[0]),
      ).toThrow(/non-empty buildIdBySystem|buildIdBySystem|resolveDrvPath/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("construction crashes when buildIdBySystem is empty object", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-w47e-"));
    try {
      expect(() =>
        buildHostPool({
          initialHosts: [],
          resolveDrvPath: fakeResolve,
          hostsFile: join(dir, "hosts.json"),
          buildIdBySystem: {},
        }),
      ).toThrow(/non-empty buildIdBySystem/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("off-nix pool constructs without resolveDrvPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-w47off-"));
    try {
      const pool = buildHostPool({
        initialHosts: [],
        hostsFile: join(dir, "hosts.json"),
      });
      expect(pool.hosts()).toEqual([]);
      await pool.destroyAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("type pin: provisioning pool without ids is unspellable (@ts-expect-error)", () => {
    // Compile-time pin: the following line must type-error. If it stops
    // erroring, the discriminated union regressed.
    // @ts-expect-error W4.7 provisioning requires buildIdBySystem
    const _bad: import("./hostRegistry").ProvisioningHostPoolOptions = {
      initialHosts: [],
      hostsFile: "/tmp/x",
      resolveDrvPath: fakeResolve,
    };
    void _bad;
  });

  it("off-nix with hosts constructs can't-judge sessions (W5.6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-w47h-"));
    try {
      writeFileSync(join(dir, "hosts.json"), JSON.stringify({ hosts: [] }));
      const pool = buildHostPool({
        initialHosts: ["localhost"],
        hostsFile: join(dir, "hosts.json"),
      });
      const session = pool.getSession("localhost");
      expect(session).toBeDefined();
      // Policy binder empty ⇒ can't-judge (off-nix).
      const { drishtiAgentConvergencePolicy } = await import("./hostRegistry");
      expect(drishtiAgentConvergencePolicy("").baked.build).toEqual({
        kind: "off-nix",
      });
      await pool.destroyAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("type pin: off-nix pool with resolver is unspellable (@ts-expect-error)", () => {
    const _bad = {
      initialHosts: [] as string[],
      hostsFile: "/tmp/x",
      resolveDrvPath: fakeResolve,
    };
    // @ts-expect-error W5.6 off-nix arm must not spell resolveDrvPath
    const _x: import("./hostRegistry").OffNixHostPoolOptions = _bad;
    void _x;
  });

  it("missing system at real pool resolve crashes (W5.6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-w56miss-"));
    try {
      writeFileSync(join(dir, "hosts.json"), JSON.stringify({ hosts: [] }));
      const pool = buildHostPool({
        initialHosts: [],
        hostsFile: join(dir, "hosts.json"),
        buildIdBySystem: { "aarch64-linux": "only-arm" },
        resolveDrvPath: async () => ({
          derivation: directAgentDerivation(
            "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-drishti-agent.drv",
            TEST_BINARY_CACHE,
          ),
          system: "x86_64-linux",
        }),
      });
      // Drive resolve via expectProvisionedBuildId through the production helper
      // path used at resolveDrvPath time in buildEntry.
      expect(() =>
        expectProvisionedBuildId({
          system: "x86_64-linux",
          buildIdBySystem: { "aarch64-linux": "only-arm" },
          fallbackBuildId: "",
          provisioning: true,
        }),
      ).toThrow(/missing BUILD_ID for system/);
      await pool.destroyAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing system at resolve throws via expectProvisionedBuildId (real helper)", () => {
    expect(() =>
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: { "aarch64-linux": "only-arm" },
        fallbackBuildId: "",
        provisioning: true,
      }),
    ).toThrow(/missing BUILD_ID for system/);
  });

  it("PRODUCTION mutation pin: provisioning is not ids-map emptiness", () => {
    // Construction with resolver + non-empty ids succeeds; empty ids crashes.
    // Re-deriving provisioning from ids emptiness would accept empty+resolver
    // as off-nix and silently construct — this asserts the loud path.
    const dir = mkdtempSync(join(tmpdir(), "pool-w47mut-"));
    try {
      writeFileSync(join(dir, "hosts.json"), JSON.stringify({ hosts: [] }));
      expect(() =>
        buildHostPool({
          initialHosts: [],
          resolveDrvPath: fakeResolve,
          hostsFile: join(dir, "hosts.json"),
          buildIdBySystem: {},
        }),
      ).toThrow(/non-empty buildIdBySystem/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("drain persist-failure capture (W4.2)", () => {
  it("captureDrainPersistFailure maps ORPCError DRISHTI_PERSIST_FAILED", () => {
    const r = captureDrainPersistFailure(
      new ORPCError("DRISHTI_PERSIST_FAILED", {
        message: "EACCES write",
        data: { persistFailed: true, error: "EACCES write" },
      }),
    );
    expect(r).toEqual({
      persistFailed: true,
      error: "EACCES write",
    });
  });

  it("convergenceFromDrainPersistFailure projects drained-with-persist-failure", () => {
    const c = convergenceFromDrainPersistFailure({
      persistFailed: true,
      error: "EACCES",
    });
    expect(c).toEqual({
      kind: "drained-with-persist-failure",
      detail: "final history ring flush failed during drain",
      error: "EACCES",
    });
  });

  it("null capture ⇒ no projection (mutation pin for raw fireDrain)", () => {
    expect(captureDrainPersistFailure(new Error("other"))).toBeNull();
    expect(convergenceFromDrainPersistFailure(null)).toBeNull();
  });
});

describe("W5.2 standing drained-with-persist-failure after adopt", () => {
  it("adopt arm does not clear drained-with-persist-failure (production source)", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "hostRegistry.ts"),
      "utf8",
    );
    // Production: adopt only clears when NOT standing persist-failure.
    expect(src).toMatch(
      /case "adopt":\s*\{[\s\S]*?drained-with-persist-failure[\s\S]*?setActiveCombined\(active\)/,
    );
    // Mutation: raw fireDrain without wrapper is absent from admit path.
    const admitBlock = src.match(
      /function makeAgentAdmit[\s\S]*?^\}/m,
    );
    expect(admitBlock).not.toBeNull();
    expect(src).toMatch(/await probe\.fireDrain\(\)/);
    expect(src).toMatch(/captureDrainPersistFailure/);
  });

  it("convergenceFromDrainPersistFailure is what adopt must preserve", () => {
    const projected = convergenceFromDrainPersistFailure({
      persistFailed: true,
      error: "EACCES",
    });
    expect(projected?.kind).toBe("drained-with-persist-failure");
  });
});
