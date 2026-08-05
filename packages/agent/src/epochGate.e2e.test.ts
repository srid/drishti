/**
 * The epoch gate's falsifier (juspay/kolu#2101, F5b — drishti's fleet arm).
 *
 * The incident's signature was an INFINITE loop: a previous-epoch daemon held
 * the rendezvous, `drishti-agent --stdio` spliced into it blind, the parent's
 * RPC client attached, and the pinger killed the link ~10s later with a generic
 * transport error that classified as "network" — which never counts toward a
 * give-up budget and never goes terminal.
 *
 * The acceptance criterion is the inverse of that, and it is what this file
 * asserts: a previous-epoch resident produces **one takeover and one clean
 * converge**. Not a loop, and not a refusal either — the front is supposed to
 * FIX this, on the box where the gate file and the signals live.
 *
 * ## Why these tests would have failed before the fix
 *
 * Revert `main.ts`'s converge-and-greet pre-step and the first test cannot even
 * reach its assertions: `dialOverStdio` awaits the readiness banner, and a
 * blind-splicing front never writes one, so the dial fails at the gate instead
 * of ten seconds later as a nondescript transport death. Revert only the
 * takeover (leave the greet) and the dial still fails — the mute daemon is
 * still there, and `control.hello()` gets no answer.
 *
 * Gated on `KOLU_DAEMON_TESTS` like every other real-process lane here.
 */

import { describe, expect, it, afterEach } from "bun:test";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { drishtiAgentFrontConvergencePolicy } from "drishti-common/convergence-policy";
import { type DaemonDial, dialOverStdio } from "./dialDaemon.testlib";

const daemonTests = process.env.KOLU_DAEMON_TESTS === "1";
const agentMain = join(import.meta.dir, "main.ts");
const muteMain = join(import.meta.dir, "fixtures", "muteEpochDaemon.ts");

const temps: string[] = [];
const children: ChildProcess[] = [];
const dials: DaemonDial[] = [];

afterEach(async () => {
  for (const d of dials.splice(0)) {
    try {
      d.dispose();
    } catch {
      /* already gone */
    }
  }
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "drishti-epoch-gate-"));
  temps.push(d);
  mkdirSync(join(d, ".local", "state"), { recursive: true, mode: 0o700 });
  return d;
}

function agentEnv(home: string, buildId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, ".local", "state"),
    // both-or-neither: readBakedIdentity throws on a half pair.
    DRISHTI_AGENT_BUILD_ID: buildId,
    DRISHTI_AGENT_COMMIT_HASH: `epoch-commit-${buildId}`,
  };
}

function spawnChild(entry: string, home: string, buildId: string): ChildProcess {
  const child = nodeSpawn(process.execPath, [entry, ...(entry === agentMain ? ["--stdio"] : [])], {
    env: agentEnv(home, buildId),
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function statePaths(home: string): { socketPath: string; gatePath: string } {
  const dir = join(home, ".local", "state", "drishti");
  return {
    socketPath: join(dir, "drishti.sock"),
    gatePath: join(dir, "drishti.pid"),
  };
}

/** The pid currently named by the gate file — the resident's identity as every
 *  supervisor reads it. */
function gatePid(home: string): number {
  const { gatePath } = statePaths(home);
  const [pid] = readFileSync(gatePath, "utf-8").trim().split("\t");
  return Number(pid);
}

async function waitForRendezvous(home: string, timeoutMs = 15_000): Promise<void> {
  const { socketPath, gatePath } = statePaths(home);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath) && existsSync(gatePath)) return;
    await delay(50);
  }
  throw new Error(`rendezvous never appeared under ${home}`);
}

/** True once `pid` is gone. `kill(pid, 0)` is the same liveness edge the gate
 *  machinery uses, so the test agrees with the code about what "gone" means. */
function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitForDeath(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDead(pid)) return;
    await delay(50);
  }
  throw new Error(`pid ${pid} was still alive after ${timeoutMs}ms`);
}

describe("epoch gate — the fleet arm's previous-epoch resident", () => {
  it.skipIf(!daemonTests)(
    "a mute previous-epoch daemon is taken over ONCE and the front greets ready",
    async () => {
      const home = tempHome();
      const buildId = "epoch-gate-build";

      // ── A previous-epoch daemon holds the rendezvous ──────────────────────
      const mute = spawnChild(muteMain, home, "prev-epoch-build");
      await waitForRendezvous(home);
      const mutePid = gatePid(home);
      expect(mutePid).toBe(mute.pid!);

      // ── The front dials it, exactly as `ssh <host> drishti-agent --stdio` ──
      const front = spawnChild(agentMain, home, buildId);

      // `dialOverStdio` awaits the readiness banner before it will attach an
      // RPC client. Reaching a live `hello` at all is therefore the assertion:
      // the front greeted `ready`, and it only greets after converging.
      const dial = await dialOverStdio(front.stdout!, front.stdin!);
      dials.push(dial);
      const hello = await dial.control.hello();

      // The daemon now answering is OURS, not the mute one — the takeover
      // happened, and it replaced the resident with a daemon of this closure.
      expect(hello.buildId).toBe(buildId);

      // ONE takeover: the mute holder is gone, and the gate names somebody else.
      await waitForDeath(mutePid);
      expect(gatePid(home)).not.toBe(mutePid);

      // And the link is a working surface, not just a handshake.
      const info = await dial.control.hello();
      expect(info.stateRoot.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it.skipIf(!daemonTests)(
    "the takeover is not a loop — a second front adopts the converged daemon untouched",
    async () => {
      const home = tempHome();
      const buildId = "epoch-gate-build";

      const mute = spawnChild(muteMain, home, "prev-epoch-build");
      await waitForRendezvous(home);
      const mutePid = gatePid(home);

      const front1 = spawnChild(agentMain, home, buildId);
      const dial1 = await dialOverStdio(front1.stdout!, front1.stdin!);
      dials.push(dial1);
      await dial1.control.hello();
      await waitForDeath(mutePid);
      const adoptedPid = gatePid(home);
      expect(adoptedPid).not.toBe(mutePid);

      // A SECOND dial is the part the incident never reached. Once converged,
      // a front must adopt in place: no drain, no respawn, same pid. A front
      // that re-took-over here would be the livelock wearing different clothes.
      const front2 = spawnChild(agentMain, home, buildId);
      const dial2 = await dialOverStdio(front2.stdout!, front2.stdin!);
      dials.push(dial2);
      const hello2 = await dial2.control.hello();

      expect(hello2.buildId).toBe(buildId);
      expect(gatePid(home)).toBe(adoptedPid);
    },
    60_000,
  );
});

describe("the front's convergence policy is epoch-only", () => {
  // A pure assertion, and the most valuable one in this file: it pins the
  // LAYERING decision that the e2es above can only exercise indirectly. The
  // front answers "does a daemon of this epoch hold the rendezvous"; every
  // in-epoch verdict — contract skew, build mismatch, the drain budget, the
  // standing anomaly, the renew affordance — stays with the parent's
  // `convergeAdmit`, which is the only one of the two with a UI.
  //
  // If someone later gives the front the parent's policy, drishti's whole
  // skew → degraded → renew path goes unreachable in production: the front
  // would refuse before the parent ever saw the resident. That regression is
  // invisible to a typechecker and expensive to find in a fleet, so it is
  // pinned here as data.
  const policy = drishtiAgentFrontConvergencePolicy("some-build");

  it("never drains: no drain arms and no budget are even spellable", () => {
    expect(policy.capability).toBe("not-drainable");
    expect(policy).not.toHaveProperty("drainBudget");
  });

  it("leaves an in-epoch resident standing for the parent to adjudicate", () => {
    // `refuse` = leave the survivor standing, never touch it.
    expect(policy.onContractSkew.kind).toBe("refuse");
    // `nudge-human` = take no supervisor action, return the mismatch upward.
    expect(policy.onBuildMismatch.kind).toBe("nudge-human");
  });

  it("carries this closure's own identity as the expectation", () => {
    expect(policy.baked.build).toEqual({ kind: "known", id: "some-build" });
  });
});
