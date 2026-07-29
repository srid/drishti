/**
 * Synthetic mixed-build window (UW3 bootstrap).
 *
 * Drishti has no daemon-capable previous release tag yet, so the mixed-build
 * proof cannot resolve a real previous tag (that hard-refuses when previous
 * equals current). Instead we drive a REAL build-axis drain through the
 * framework's `convergeAdmit` skeleton with a synthetic previous identity
 * (same surface, different baked buildId) and assert the successor path
 * re-reads history from `history.ring.json`.
 *
 * At the first daemon-capable release tag, the previous-tag resolver
 * (`assertPreviousReleaseWindow` + `runPreviousReleaseWindow`) arms with its
 * "previous must differ from current" hard refusal.
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
      contractVersion: "1.0",
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
  drain: () => Promise<void>;
  awaitExit: (signal: AbortSignal) => Promise<void>;
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

describe("synthetic mixed-build window (UW3 bootstrap)", () => {
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
        contractVersion: "1.0",
        build: daemonBuild(previousBuildId),
        instanceKey: instanceKeyFromStartedAt(1_700_000_000_000),
      },
      drain: async () => {
        drained = true;
        // Drain flushes ring (already on disk) then exits.
        exitResolve?.();
      },
      awaitExit: (signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const onAbort = () => {
            cleanup();
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          let done = false;
          const cleanup = () => {
            if (done) return;
            done = true;
            signal.removeEventListener("abort", onAbort);
          };
          void processExit.then(() => {
            cleanup();
            resolve();
          });
        }),
    });

    const silentLog = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => silentLog,
    };
    const verdict = await convergeAdmit({
      running: {
        ...probe.identity,
        instanceKey: probe.instanceKey,
      },
      budget,
      drain: probe.fireDrain,
      awaitExit: probe.awaitExit,
      ceilingMs: probe.drainCeilingMs,
      log: silentLog as never,
    });

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
