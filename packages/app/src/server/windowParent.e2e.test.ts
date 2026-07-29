/**
 * W2.1: done-when (b) through the PRODUCTION parent path.
 *
 * Uses `drishtiAgentConvergencePolicy` + `createConnectorDrainBudget` from the
 * production hostRegistry policy object (not a test-side policy literal), and
 * drives drain via the same budget/admit arms the pool uses. A mutation that
 * flips a production policy arm or removes the production drain flush goes red.
 *
 * Full `buildHostPool`+nix provision is optional when DRVS is available; the
 * always-on core proves production policy + real previous drain write.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { composeSurfaceContracts } from "@kolu/surface/define";
import { stdioLink } from "@kolu/surface/links/stdio";
import {
  controlCoreSurface,
  daemonBuild,
  daemonHome,
} from "@kolu/surface-daemon";
import {
  convergeAdmit,
  createConnectorDrainBudget,
  probeDaemonIdentityFrom,
} from "@kolu/surface-daemon-supervisor";
import { AGENT_SURFACE_VERSION, surface } from "drishti-common";
import {
  drishtiAgentConvergencePolicy,
  expectProvisionedBuildId,
} from "./hostRegistry";

const agentMain = join(
  import.meta.dir,
  "../../../agent/src/main.ts",
);

const agentDaemonContract = composeSurfaceContracts({
  app: surface,
  control: controlCoreSurface,
});

const temps: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      // gone
    }
  }
  for (const d of temps.splice(0)) {
    try {
      process.env.HOME = d;
      process.env.XDG_STATE_HOME = join(d, ".local", "state");
      const home = daemonHome({ app: "drishti", placement: "state" });
      if (existsSync(home.gatePath)) {
        const pid = Number.parseInt(readFileSync(home.gatePath, "utf8"), 10);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // gone
          }
        }
      }
    } catch {
      // best-effort
    }
    rmSync(d, { recursive: true, force: true });
  }
  await delay(50);
});

describe("W2.1 production parent policy + real drain write", () => {
  it("uses PRODUCTION drishtiAgentConvergencePolicy arms (mutation: flip arm ⇒ shape fails)", () => {
    const policy = drishtiAgentConvergencePolicy("current-build");
    expect(policy.capability).toBe("drainable");
    expect(policy.onBuildMismatch).toEqual({ kind: "drain-and-replace" });
    expect(policy.onContractSkew).toEqual({
      kind: "drain-newer-else-refuse",
    });
    expect(policy.drainBudget).toEqual({
      maxAttempts: 2,
      onGiveUp: "adopt-stale",
    });
    expect(policy.baked.contractVersion).toBe(AGENT_SURFACE_VERSION);
    expect(policy.baked.build).toEqual({
      kind: "known",
      id: "current-build",
    });
    // Budget mint uses the production policy object.
    const budget = createConnectorDrainBudget(policy);
    expect(budget).toBeDefined();
  });

  it("previous live-samples, PRODUCTION policy drain, successor serves drained write", async () => {
    const home = mkdtempSync(join(tmpdir(), "drishti-parent-e2e-"));
    temps.push(home);
    mkdirSync(join(home, ".local", "state"), { recursive: true, mode: 0o700 });

    const previousBuildId = "synthetic-previous-build";
    const currentBuildId = "synthetic-current-build";

    const env = {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      DRISHTI_AGENT_BUILD_ID: previousBuildId,
    };
    const front = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(front);

    // Wait for socket.
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    const dh = daemonHome({ app: "drishti", placement: "state" });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(dh.socketPath) && existsSync(dh.gatePath)) break;
      await delay(50);
    }
    expect(existsSync(dh.socketPath)).toBe(true);
    const prevPid = Number.parseInt(readFileSync(dh.gatePath, "utf8"), 10);

    if (front.stdin === null || front.stdout === null) {
      throw new Error("no stdio");
    }
    const client = stdioLink<typeof agentDaemonContract>({
      read: front.stdout,
      write: front.stdin,
    }) as {
      surface: {
        app: {
          metricHistory: {
            get: (
              i: Record<string, never>,
              o?: { signal?: AbortSignal },
            ) => Promise<AsyncIterable<{ kind: string; sample?: { t: number }; samples?: { t: number }[] }>>;
          };
        };
        control: {
          core: {
            hello: () => Promise<{ buildId?: string }>;
            drain: () => Promise<void>;
          };
        };
      };
    };

    expect((await client.surface.control.core.hello()).buildId).toBe(
      previousBuildId,
    );

    // Live samples (no pre-plant).
    const ac = new AbortController();
    const stream = await client.surface.app.metricHistory.get(
      {},
      { signal: ac.signal },
    );
    const liveTs = new Set<number>();
    const liveDeadline = Date.now() + 12_000;
    for await (const frame of stream) {
      if (frame.kind === "snapshot" && frame.samples) {
        for (const s of frame.samples) liveTs.add(s.t);
      } else if (frame.kind === "delta" && frame.sample) {
        liveTs.add(frame.sample.t);
      }
      if (liveTs.size >= 1) break;
      if (Date.now() > liveDeadline) break;
    }
    ac.abort();
    expect(liveTs.size).toBeGreaterThan(0);

    // PRODUCTION policy object drives the budget (not a test literal).
    const policy = drishtiAgentConvergencePolicy(currentBuildId);
    expect(policy.onBuildMismatch.kind).toBe("drain-and-replace");
    const budget = createConnectorDrainBudget(policy);

    // Probe + convergeAdmit with production policy budget — same skeleton
    // makeAgentAdmit uses (drainable, production arms).
    const { unixSocketLink } = await import("@kolu/surface/links/unix-socket");
    const sock = await unixSocketLink<typeof agentDaemonContract>({
      socketPath: dh.socketPath,
    });
    const probe = await probeDaemonIdentityFrom({
      client: sock.client as never,
      dispose: sock.dispose,
      capability: "drainable",
      drainCeilingMs: 8_000,
      awaitExit: async (signal) => {
        while (!signal.aborted) {
          try {
            process.kill(prevPid, 0);
          } catch {
            return;
          }
          await delay(50);
        }
      },
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

    let prevGone = false;
    const exitDeadline = Date.now() + 10_000;
    while (Date.now() < exitDeadline) {
      try {
        process.kill(prevPid, 0);
        await delay(50);
      } catch {
        prevGone = true;
        break;
      }
    }
    expect(prevGone).toBe(true);

    // Real drain write: ring on disk holds live timestamps.
    const ringPath = dh.file("history.ring.json");
    expect(existsSync(ringPath)).toBe(true);
    const raw = JSON.parse(readFileSync(ringPath, "utf8")) as {
      samples: { t: number }[];
    };
    const diskTs = new Set(raw.samples.map((s) => s.t));
    let hit = 0;
    for (const t of liveTs) {
      if (diskTs.has(t)) hit += 1;
    }
    expect(hit).toBeGreaterThan(0);

    // Successor serves those samples through the surface (not loadHistoryRing).
    const frontSucc = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
      env: { ...env, DRISHTI_AGENT_BUILD_ID: currentBuildId },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(frontSucc);
    const succDeadline = Date.now() + 15_000;
    while (Date.now() < succDeadline) {
      if (existsSync(dh.socketPath) && existsSync(dh.gatePath)) {
        const p = Number.parseInt(readFileSync(dh.gatePath, "utf8"), 10);
        if (p !== prevPid) break;
      }
      await delay(50);
    }
    if (frontSucc.stdin === null || frontSucc.stdout === null) {
      throw new Error("succ no stdio");
    }
    const clientSucc = stdioLink<typeof agentDaemonContract>({
      read: frontSucc.stdout,
      write: frontSucc.stdin,
    }) as typeof client;
    const ac2 = new AbortController();
    const stream2 = await clientSucc.surface.app.metricHistory.get(
      {},
      { signal: ac2.signal },
    );
    let servedHit = 0;
    for await (const frame of stream2) {
      if (frame.kind === "snapshot" && frame.samples) {
        const ts = new Set(frame.samples.map((s) => s.t));
        for (const t of liveTs) {
          if (ts.has(t)) servedHit += 1;
        }
        break;
      }
    }
    ac2.abort();
    expect(servedHit).toBeGreaterThan(0);
  }, 90_000);

  it("W2.6: provisioning path requires ids map entry (loud failure)", () => {
    expect(() =>
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: {},
        fallbackBuildId: "parent-only",
        provisioning: true,
      }),
    ).toThrow(/BUILD_IDS map is empty/);

    expect(() =>
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: { "aarch64-linux": "abc" },
        fallbackBuildId: "",
        provisioning: true,
      }),
    ).toThrow(/missing BUILD_ID for system/);

    expect(
      expectProvisionedBuildId({
        system: "x86_64-linux",
        buildIdBySystem: {},
        fallbackBuildId: "",
        provisioning: false,
      }),
    ).toBe("");
  });
});
