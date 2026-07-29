/**
 * W1 real window e2e — processes, --stdio front, adoption, drain, dispositions.
 *
 * Not in-process theater: each step spawns real agent processes under a temp
 * HOME, fronts them with the real `--stdio` adopt-or-spawn path, and asserts
 * done-when (a)/(b) plus boot dispositions through the served surface
 * (`metricHistory` stream), never `loadHistoryRing` called in-test for the
 * successor re-read claim.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { composeSurfaceContracts } from "@kolu/surface/define";
import { stdioLink } from "@kolu/surface/links/stdio";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import {
  controlCoreSurface,
  daemonBuild,
  daemonHome,
} from "@kolu/surface-daemon";
import {
  assertPreviousReleaseWindow,
  isPreviousReleaseTag,
} from "@kolu/surface-daemon/upgrade-window.testlib";
import {
  convergeAdmit,
  createConnectorDrainBudget,
  probeDaemonIdentityFrom,
} from "@kolu/surface-daemon-supervisor";
import { AGENT_SURFACE_VERSION, surface } from "drishti-common";
import {
  HISTORY_RING_FILE,
  HISTORY_RING_VERSION,
  saveHistoryRing,
} from "./historyRing";

const agentMain = join(import.meta.dir, "main.ts");

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
      // already gone
    }
  }
  // Detached daemons: best-effort kill via gate pid under each temp HOME.
  for (const d of temps.splice(0)) {
    try {
      const prev = process.env.HOME;
      process.env.HOME = d;
      try {
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
      } finally {
        if (prev === undefined) delete process.env.HOME;
        else process.env.HOME = prev;
      }
    } catch {
      // cleanup best-effort
    }
    rmSync(d, { recursive: true, force: true });
  }
  await delay(50);
});

function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "drishti-window-e2e-"));
  temps.push(d);
  // Materialise XDG state parent so daemonHome placement is deterministic.
  mkdirSync(join(d, ".local", "state"), { recursive: true, mode: 0o700 });
  return d;
}

function agentEnv(
  home: string,
  buildId: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    // Isolate from ambient XDG so state lands under `home`.
    XDG_STATE_HOME: join(home, ".local", "state"),
    DRISHTI_AGENT_BUILD_ID: buildId,
    // osfacts must be present in the nix-dev / CI environment.
    ...extra,
  };
}

/** Spawn the real `--stdio` front; it adopt-or-spawns the durable daemon. */
function spawnFront(
  home: string,
  buildId: string,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcess {
  const child = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
    env: agentEnv(home, buildId, extraEnv),
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

async function waitForSocket(home: string, ms = 15_000): Promise<string> {
  const prev = process.env.HOME;
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  try {
    const h = daemonHome({ app: "drishti", placement: "state" });
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (existsSync(h.socketPath) && existsSync(h.gatePath)) {
        return h.socketPath;
      }
      await delay(50);
    }
    throw new Error(
      `daemon socket did not appear under ${h.dir} within ${ms}ms`,
    );
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
}

function gatePid(home: string): number {
  const prev = process.env.HOME;
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  try {
    const h = daemonHome({ app: "drishti", placement: "state" });
    const raw = readFileSync(h.gatePath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error(`invalid gate pid: ${raw}`);
    }
    return pid;
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
}

function ringPath(home: string): string {
  const prev = process.env.HOME;
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  try {
    return daemonHome({ app: "drishti", placement: "state" }).file(
      HISTORY_RING_FILE,
    );
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
}

function homeDir(home: string): string {
  const prev = process.env.HOME;
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  try {
    return daemonHome({ app: "drishti", placement: "state" }).dir;
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
}

/** Dial the front over its real stdio pipes (framework connector path shape). */
function dialFront(front: ChildProcess) {
  if (front.stdin === null || front.stdout === null) {
    throw new Error("front missing stdio pipes");
  }
  return stdioLink<typeof agentDaemonContract>({
    read: front.stdout,
    write: front.stdin,
  });
}

type CombinedClient = {
  surface: {
    app: {
      metricHistory: {
        get: (
          input: Record<string, never>,
          opts?: { signal?: AbortSignal },
        ) => Promise<AsyncIterable<{ kind: string; reason?: string; samples?: unknown[] }>>;
      };
    };
    control: {
      core: {
        hello: () => Promise<{
          buildId?: string;
          startedAt: number;
          surfaceVersion: string;
        }>;
        drain: () => Promise<void>;
      };
    };
  };
};

async function firstHistoryFrame(
  client: CombinedClient,
  signal: AbortSignal,
): Promise<{ kind: string; reason?: string; samples?: unknown[] }> {
  // Combined contract: streams live under surface.app as `.get(...)`.
  const stream = await client.surface.app.metricHistory.get({}, { signal });
  for await (const frame of stream) {
    return frame;
  }
  throw new Error("metricHistory stream ended without a frame");
}

describe("W1 real window e2e", () => {
  it("done-when (a): disconnect last session, redial ⇒ same daemon pid adopted", async () => {
    const home = tempHome();
    const buildId = "e2e-adopt-build";

    // First front: spawn daemon + relay.
    const front1 = spawnFront(home, buildId);
    await waitForSocket(home);
    const pid1 = gatePid(home);
    expect(pid1).toBeGreaterThan(0);
    // Prove the process is live.
    process.kill(pid1, 0);

    const client1 = dialFront(front1) as unknown as CombinedClient;
    const hello1 = await client1.surface.control.core.hello();
    expect(hello1.buildId).toBe(buildId);

    // Drop the LAST session (kill the only front). Daemon must stay.
    front1.kill("SIGTERM");
    await delay(300);
    // Gate pid still alive — adoption target.
    process.kill(pid1, 0);

    // Second front: adopt, not spawn.
    const front2 = spawnFront(home, buildId);
    await waitForSocket(home);
    const pid2 = gatePid(home);
    expect(pid2).toBe(pid1); // SAME daemon pid adopted

    const client2 = dialFront(front2) as unknown as CombinedClient;
    const hello2 = await client2.surface.control.core.hello();
    expect(hello2.buildId).toBe(buildId);

    front2.kill("SIGTERM");
  }, 60_000);

  it("done-when (b): synthetic previous drains, exits; successor serves history from disk via surface", async () => {
    const home = tempHome();
    const previousBuildId = "synthetic-previous-build";
    const currentBuildId = "synthetic-current-build";
    expect(previousBuildId).not.toBe(currentBuildId);

    // Plant ring as the previous daemon would have left it (before spawn so
    // boot loads it). Timestamps must be within HISTORY_RETENTION_MS of "now"
    // or the first tick's pushSample would evict them as ancient.
    const now = Date.now();
    const samples = [
      { t: now - 4_000, cpu: 10, mem: 20, swap: 0, disk: 40 },
      { t: now - 2_000, cpu: 12, mem: 21, swap: 0, disk: 40 },
    ];
    // Ensure daemon home dir exists for the plant.
    mkdirSync(homeDir(home), { recursive: true, mode: 0o700 });
    saveHistoryRing(ringPath(home), samples, { items: ["cpu"] });

    // Boot previous with different baked build id.
    const frontPrev = spawnFront(home, previousBuildId);
    const socketPath = await waitForSocket(home);
    const prevPid = gatePid(home);

    const clientPrev = dialFront(frontPrev) as unknown as CombinedClient;
    const helloPrev = await clientPrev.surface.control.core.hello();
    expect(helloPrev.buildId).toBe(previousBuildId);

    // Parent policy + convergeAdmit drives the drain (real probe path).
    const policy = {
      capability: "drainable" as const,
      baked: {
        contractVersion: AGENT_SURFACE_VERSION,
        build: daemonBuild(currentBuildId),
      },
      onContractSkew: { kind: "drain-newer-else-refuse" as const },
      onBuildMismatch: { kind: "drain-and-replace" as const },
      drainBudget: {
        maxAttempts: 2,
        onGiveUp: "adopt-stale" as const,
      },
    };
    const budget = createConnectorDrainBudget(policy);

    // Dial a socket client for the probe (dispose independent of front).
    const sock = await unixSocketLink<typeof agentDaemonContract>({
      socketPath,
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
            return; // pid gone
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

    // PREVIOUS process actually exits (pid gone).
    const exitDeadline = Date.now() + 10_000;
    let prevGone = false;
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

    // Front for previous may have died with the daemon; drop tracking.
    try {
      frontPrev.kill("SIGKILL");
    } catch {
      // gone
    }

    // Successor process with current build id; serves history re-read from
    // history.ring.json THROUGH the served surface (not loadHistoryRing).
    const frontSucc = spawnFront(home, currentBuildId);
    await waitForSocket(home);
    const succPid = gatePid(home);
    expect(succPid).not.toBe(prevPid);

    const clientSucc = dialFront(frontSucc) as unknown as CombinedClient;
    const helloSucc = await clientSucc.surface.control.core.hello();
    expect(helloSucc.buildId).toBe(currentBuildId);

    const ac = new AbortController();
    const frame = await firstHistoryFrame(clientSucc, ac.signal);
    ac.abort();
    // Served surface re-read the ring from disk (not loadHistoryRing in-test).
    // Planted samples must be present (previous may have appended more).
    expect(frame.kind).toBe("snapshot");
    const served = frame.samples ?? [];
    const plantedTs = new Set(samples.map((s) => s.t));
    const recovered = served.filter((s) => plantedTs.has((s as { t: number }).t));
    expect(recovered.length).toBe(2);
    expect(recovered).toEqual(samples);

    frontSucc.kill("SIGTERM");
  }, 90_000);

  it("F9 boot dispositions via real path: garbage ⇒ unavailable + moved aside; v+1 ⇒ unavailable + left alone", async () => {
    // Push corrupt→fresh recovery past this test window so standing unavailable
    // is observable (recovery still runs on the 60s interval / drain).
    const slowPersist = { DRISHTI_RING_PERSIST_MS: "60000" };

    // ── garbage ────────────────────────────────────────────────────────
    {
      const home = tempHome();
      mkdirSync(homeDir(home), { recursive: true, mode: 0o700 });
      const path = ringPath(home);
      writeFileSync(path, '{"v":1,"samples":[', "utf8");

      const front = spawnFront(home, "e2e-disp-garbage", slowPersist);
      await waitForSocket(home);
      const client = dialFront(front) as unknown as CombinedClient;
      const ac = new AbortController();
      const frame = await firstHistoryFrame(client, ac.signal);
      ac.abort();

      expect(frame.kind).toBe("unavailable");
      expect(frame.reason).toBe("corrupt");
      // File moved aside (never deleted).
      expect(existsSync(path)).toBe(false);
      const siblings = readdirSync(homeDir(home)).filter((n) =>
        n.startsWith("history.ring.json.corrupt-"),
      );
      expect(siblings.length).toBe(1);

      // W2: late subscriber still sees standing unavailable.
      const ac2 = new AbortController();
      const late = await firstHistoryFrame(client, ac2.signal);
      ac2.abort();
      expect(late.kind).toBe("unavailable");
      expect(late.reason).toBe("corrupt");

      front.kill("SIGTERM");
    }

    // ── v+1 ────────────────────────────────────────────────────────────
    {
      const home = tempHome();
      mkdirSync(homeDir(home), { recursive: true, mode: 0o700 });
      const path = ringPath(home);
      const planted = {
        v: HISTORY_RING_VERSION + 1,
        samples: [{ t: 1, cpu: 0, mem: 0, swap: 0, disk: 0 }],
      };
      writeFileSync(path, JSON.stringify(planted), "utf8");

      const front = spawnFront(home, "e2e-disp-vplus", slowPersist);
      await waitForSocket(home);
      const client = dialFront(front) as unknown as CombinedClient;
      const ac = new AbortController();
      const frame = await firstHistoryFrame(client, ac.signal);
      ac.abort();

      expect(frame.kind).toBe("unavailable");
      expect(frame.reason).toBe("unknown-version");
      // File LEFT ALONE.
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(planted);

      // W2 standing: second subscriber still unavailable.
      const ac2 = new AbortController();
      const late = await firstHistoryFrame(client, ac2.signal);
      ac2.abort();
      expect(late.kind).toBe("unavailable");
      expect(late.reason).toBe("unknown-version");

      front.kill("SIGTERM");
    }
  }, 90_000);

  it("previous-tag resolver hard-refuses when previous equals current (armed unit)", () => {
    expect(isPreviousReleaseTag("v0.1.0")).toBe(true);
    expect(() =>
      assertPreviousReleaseWindow({
        ref: "v0.1.0",
        previousStore: "/nix/store/aaa-drishti-agent",
        currentStore: "/nix/store/aaa-drishti-agent",
      }),
    ).toThrow(/collapsed|equals current/);
  });
});
