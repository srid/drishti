/**
 * Unit: synthetic mixed-build policy skeleton (NOT an e2e / window proof).
 *
 * The real window e2e lives in `window.e2e.test.ts` (W1): real processes,
 * --stdio front, adopt pid equality, drain exit, dispositions via the
 * served surface. This file only unit-tests convergeAdmit policy wiring and
 * the previous-tag arming gate ("previous must differ from current").
 *
 * At the first daemon-capable release tag, the previous-tag resolver
 * (`assertPreviousReleaseWindow` + `runPreviousReleaseWindow`) arms with its
 * hard refusal when previous equals current.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonBuild } from "@kolu/surface-daemon";
import {
  assertPreviousReleaseWindow,
  isPreviousReleaseTag,
} from "@kolu/surface-daemon/upgrade-window.testlib";
import {
  convergeAdmit,
  createConnectorDrainBudget,
  instanceKeyFromStartedAt,
  type DrainableProbe,
  type InstanceKey,
} from "@kolu/surface-daemon-supervisor";
import { AGENT_SURFACE_VERSION } from "drishti-common";
import { Effect } from "effect";
import {
  HISTORY_RING_FILE,
  loadHistoryRing,
  saveHistoryRing,
} from "./historyRing";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** UW3 parent policy shape (mirrored from hostRegistry — agent tests cannot
 *  import the app package). Keep arms byte-identical to the parent policy. */
function syntheticPolicy(binderBuildId: string) {
  return {
    capability: "drainable" as const,
    baked: {
      contractVersion: AGENT_SURFACE_VERSION,
      build: daemonBuild(binderBuildId),
    },
    onContractSkew: { kind: "drain-newer-else-refuse" as const },
    onBuildMismatch: { kind: "drain-and-replace" as const },
    drainBudget: {
      maxAttempts: 2,
      onGiveUp: "adopt-stale" as const,
    },
  };
}

function syntheticProbe(args: {
  running: {
    contractVersion: string;
    build: ReturnType<typeof daemonBuild>;
    instanceKey: InstanceKey;
  };
  drain: Effect.Effect<void, unknown>;
  awaitExit: Effect.Effect<void>;
}): DrainableProbe {
  return {
    capability: "drainable",
    identity: {
      contractVersion: args.running.contractVersion,
      build: args.running.build,
    },
    instanceKey: args.running.instanceKey,
    dispose: () => {},
    fireDrain: args.drain,
    awaitExit: args.awaitExit,
    drainCeilingMs: 2_000,
  };
}

describe("synthetic mixed-build policy unit (not e2e)", () => {
  it("build-axis drain via convergeAdmit then successor re-reads history.ring.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drishti-mixed-"));
    temps.push(dir);
    const ringPath = join(dir, HISTORY_RING_FILE);

    // Plant a ring as the "previous" daemon would have left it.
    const samples = [
      { t: 1_000, cpu: 10, mem: 20, swap: 0, disk: 40 },
      { t: 3_000, cpu: 12, mem: 21, swap: 0, disk: 40 },
    ];
    saveHistoryRing(ringPath, samples);

    // Synthetic previous: same contract, different buildId.
    const previousBuildId = "synthetic-previous-build";
    const currentBuildId = "synthetic-current-build";
    expect(previousBuildId).not.toBe(currentBuildId);

    const policy = syntheticPolicy(currentBuildId);
    const budget = createConnectorDrainBudget(policy);

    let drained = false;
    let exitResolve: (() => void) | undefined;
    const processExit = new Promise<void>((r) => {
      exitResolve = r;
    });

    const probe = syntheticProbe({
      running: {
        contractVersion: AGENT_SURFACE_VERSION,
        build: daemonBuild(previousBuildId),
        instanceKey: instanceKeyFromStartedAt(1_700_000_000_000),
      },
      drain: Effect.sync(() => {
        drained = true;
        // Drain flushes ring (already on disk) then exits.
        exitResolve?.();
      }),
      // The exit oracle needs no abort signal any more: convergeAdmit forks it
      // into a scope it closes when the ceiling wins, so it is INTERRUPTED
      // rather than notified. An abandoned AbortController was refusable;
      // interruption is not.
      awaitExit: Effect.promise(() => processExit),
    });

    const silentLog = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => silentLog,
    };
    const verdict = await Effect.runPromise(
      convergeAdmit({
        running: {
          ...probe.identity,
          instanceKey: probe.instanceKey,
        },
        budget,
        drain: probe.fireDrain,
        awaitExit: probe.awaitExit,
        ceilingMs: probe.drainCeilingMs,
        log: silentLog as never,
      }),
    );

    expect(verdict.kind).toBe("replaced");
    expect(drained).toBe(true);

    // Successor re-reads history.ring.json — samples survive the build-axis drain.
    const loaded = loadHistoryRing(ringPath);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind === "ok") {
      expect(loaded.samples).toEqual(samples);
    }
  });

  it("documents the previous-tag arming gate for the first daemon-capable release", () => {
    // Framework assertion stays wired so the real previous-tag resolver can
    // arm at the first daemon-capable release. Until then, synthetic ids
    // above drive the window.
    expect(isPreviousReleaseTag("v0.1.0")).toBe(true);
    expect(isPreviousReleaseTag("not-a-tag")).toBe(false);

    // The hard refusal: previous must differ from current.
    expect(() =>
      assertPreviousReleaseWindow({
        ref: "v0.1.0",
        previousStore: "/nix/store/aaa-drishti-agent",
        currentStore: "/nix/store/aaa-drishti-agent",
      }),
    ).toThrow(/collapsed|equals current/);
  });
});
