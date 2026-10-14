/**
 * W4 pool construction (discriminated union) + drain persist capture.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildHostPool,
  drainPersistFailureOf,
  convergenceFromDrainPersistFailure,
  type OffNixHostPoolOptions,
  type ProvisioningHostPoolOptions,
} from "./hostRegistry";

/** A baked agent source that is not there. The framework reads the source's
 *  own `binary-cache.json` before any ssh or Nix work, so a resolve through it
 *  fails instantly and deterministically — which is what makes the wiring
 *  ("the pool's resolver IS `ctx.resolveAgentDrv(agentFlakeRef, …)`")
 *  observable without a store fixture. */
const MISSING_SOURCE = "/nix/store/does-not-exist-drishti-agent-source";

describe("buildHostPool discriminated construction (W4.7)", () => {
  it("construction crashes when provisioning without an expectedBuildId", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-w47-"));
    try {
      // Omit expectedBuildId via cast — the type forbids it, and runtime still
      // refuses: no admitted path has an "unknown which agent" arm.
      const bad = {
        initialHosts: [] as const,
        agentFlakeRef: MISSING_SOURCE,
        hostsFile: join(dir, "hosts.json"),
      };
      expect(() =>
        buildHostPool(bad as unknown as Parameters<typeof buildHostPool>[0]),
      ).toThrow(/non-empty expectedBuildId/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("construction crashes when expectedBuildId is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-w47e-"));
    try {
      expect(() =>
        buildHostPool({
          initialHosts: [],
          agentFlakeRef: MISSING_SOURCE,
          expectedBuildId: "",
          hostsFile: join(dir, "hosts.json"),
        }),
      ).toThrow(/non-empty expectedBuildId/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("off-nix pool constructs without a provision path", async () => {
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

  it("type pin: provisioning pool without a baked source is unspellable (@ts-expect-error)", () => {
    // Compile-time pin: the following line must type-error. If it stops
    // erroring, the discriminated union regressed.
    // @ts-expect-error W4.7 provisioning requires agentFlakeRef + expectedBuildId
    const _bad: ProvisioningHostPoolOptions = {
      initialHosts: [],
      hostsFile: "/tmp/x",
      expectedBuildId: "id",
    };
    void _bad;
  });

  it("off-nix with hosts: constructs + can't-judge policy; dial has no provision path (W6.6)", async () => {
    // HONEST SHRINK (W6.6): sshConnector always requires resolveDrvPath success
    // before dial. Off-nix intentionally throws unavailable at resolve — so pin
    // never reaches admit/can't-judge on the wire. What IS real:
    //   (1) pool constructs sessions for hosts
    //   (2) empty binder build is can't-judge (policy unit)
    //   (3) pin fails at resolve (no silent dial)
    const dir = mkdtempSync(join(tmpdir(), "pool-w66off-"));
    try {
      writeFileSync(join(dir, "hosts.json"), JSON.stringify({ hosts: [] }));
      const pool = buildHostPool({
        initialHosts: ["localhost"],
        hostsFile: join(dir, "hosts.json"),
      });
      const session = pool.getSession("localhost");
      expect(session).toBeDefined();
      const { drishtiAgentConvergencePolicy } = await import("./hostRegistry");
      expect(drishtiAgentConvergencePolicy("").baked.build).toEqual({
        kind: "off-nix",
      });
      // W8.1: assert structured resolution KIND (not message match).
      try {
        await session!.pin();
      } catch {
        // resolve fails; outcome is projected on the session
      }
      const deadline = Date.now() + 10_000;
      let out = session!.outcome();
      while (Date.now() < deadline) {
        out = session!.outcome();
        if (out?.kind === "resolve-failed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(out).not.toBeNull();
      expect(out!.kind).toBe("resolve-failed");
      if (out !== null && out.kind === "resolve-failed") {
        expect(out.resolutionKind).toBe("unavailable");
      }
      await pool.destroyAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("type pin: off-nix pool with a provision path is unspellable (@ts-expect-error)", () => {
    const _bad = {
      initialHosts: [] as string[],
      hostsFile: "/tmp/x",
      agentFlakeRef: MISSING_SOURCE,
    };
    // @ts-expect-error W5.6 off-nix arm must not spell a provision path
    const _x: OffNixHostPoolOptions = _bad;
    void _x;
  });

  it("a provisioning pool resolves THROUGH the configured baked source (W6.6)", async () => {
    // The pool's resolver is `ctx.resolveAgentDrv(agentFlakeRef, …)`, so the
    // ref it was constructed with is what the framework reads. A source that is
    // not a baked agent tree therefore fails at resolve — before any ssh or Nix
    // work — and says so with the framework's own words.
    const dir = mkdtempSync(join(tmpdir(), "pool-w66src-"));
    try {
      writeFileSync(join(dir, "hosts.json"), JSON.stringify({ hosts: [] }));
      const pool = buildHostPool({
        initialHosts: ["localhost"],
        hostsFile: join(dir, "hosts.json"),
        agentFlakeRef: MISSING_SOURCE,
        expectedBuildId: "id-x",
      });
      const session = pool.getSession("localhost");
      expect(session).toBeDefined();
      // pin() drives the real dial; a resolve failure rejects it.
      let err: unknown = null;
      try {
        await session!.pin();
      } catch (e) {
        err = e;
      }
      const RE = /binary-cache\.json[\s\S]*does-not-exist-drishti-agent-source/;
      if (err !== null) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(RE);
      } else {
        // Slower arm: the state cell carries the same reason.
        let seen = "";
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !RE.test(seen)) {
          const st = session!.currentState();
          if ("error" in st && typeof st.error === "string") seen = st.error;
          if (!RE.test(seen)) await delay(50);
        }
        expect(seen).toMatch(RE);
      }
      await pool.destroyAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("drain persist-failure verdict (W4.2)", () => {
  it("drainPersistFailureOf reads the declared drain output", () => {
    // No error to narrow any more: `daemon.ring.drain` ANSWERS. The drain
    // succeeded; its final ring write did not land.
    expect(
      drainPersistFailureOf({ persisted: false, error: "EACCES write" }),
    ).toEqual({ persistFailed: true, error: "EACCES write" });
  });

  it("a persisted drain yields NO failure", () => {
    expect(drainPersistFailureOf({ persisted: true })).toBeNull();
  });

  it("a failed drain with no reason still reports a failure", () => {
    // `error` is `optionalKey` on the wire, so absence is representable — but
    // `persisted: false` is the fact, and it must never be lost to a missing
    // string. The reason degrades, the verdict does not.
    expect(drainPersistFailureOf({ persisted: false })).toEqual({
      persistFailed: true,
      error: "persist-failed",
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

  it("no failure ⇒ no projection", () => {
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
    // Standing guard must be the NEGATIVE check (only clear when NOT standing).
    const adoptBlock = src.match(/case "adopt":\s*\{([\s\S]*?)return \{ kind: "adopt" \}/);
    expect(adoptBlock).not.toBeNull();
    expect(adoptBlock![1]).toMatch(
      /standing\?\.kind !== "drained-with-persist-failure"/,
    );
    // Mutation: raw fireDrain without wrapper is absent from admit path.
    const admitBlock = src.match(
      /function makeAgentAdmit[\s\S]*?^\}/m,
    );
    expect(admitBlock).not.toBeNull();
    // The admit path drains through drishti's OWN verb and reads its VERDICT —
    // the frozen `probe.fireDrain()` carries no channel for it (that procedure
    // declares no error, so a rejecting hook would be a defect, not a report).
    expect(src).not.toMatch(/probe\.fireDrain\(\)/);
    expect(src).toMatch(
      /Effect\.map\(active\.drain, \(verdict\) => \{[\s\S]*?drainPersistFailureOf\(verdict\)/,
    );
    // The drain is an EFFECT — a description that dispatches nothing until it
    // is run. `await active.drain` would compile, resolve WITH the Effect, and
    // report every drain as clean while never asking the daemon anything.
    expect(src).not.toMatch(/await active\.drain/);
  });

  it("convergenceFromDrainPersistFailure is what adopt must preserve", () => {
    const projected = convergenceFromDrainPersistFailure({
      persistFailed: true,
      error: "EACCES",
    });
    expect(projected?.kind).toBe("drained-with-persist-failure");
  });

  it("successful renew clears standing (production source W6.3)", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "hostRegistry.ts"),
      "utf8",
    );
    // renew success path must setConvergence(null)
    expect(src).toMatch(
      /const projected = convergenceFromDrainPersistFailure\([\s\S]*?\)\s*;\s*if \(projected !== null\)[\s\S]*?else \{[\s\S]*?setConvergence\(null\)/,
    );
  });
});

describe("W8.2 / W9 production projects replaced verdict as session data", () => {
  it("replaced arm setOutcome kind replaced + axis from contracts (source pin)", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "hostRegistry.ts"),
      "utf8",
    );
    const block = src.match(/case "replaced":\s*\{([\s\S]*?)return \{ kind: "replaced"/);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(
      /setOutcome\(\{\s*kind:\s*"replaced",\s*axis:\s*replacedAxisFromContracts/,
    );
    expect(block![1]).toMatch(/probe\.identity\.contractVersion/);
    // W9: no prose classifier on verdict.reason.
    expect(src).not.toMatch(/includes\(["']newer contract["']\)/);
    expect(src).not.toMatch(/verdict\.reason.*replacedAxis|replacedAxis\(verdict\.reason/);
    // Module-private helper (not exported) — both arms bound by gated e2e legs.
    expect(src).not.toMatch(/export function replacedAxisFromContracts/);
  });
});
