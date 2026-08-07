/**
 * Real window e2e — processes, --stdio front, adoption, drain write, dispositions.
 *
 * W2.1 done-when (b) lives in packages/app (production parent path). This file
 * covers adopt + ring intact (W2.2), live drain write proof for the agent
 * half, dispositions without env knobs (W2.9), and the previous-release
 * resolver arming (W2.3).
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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { daemonHome } from "@kolu/surface-daemon";
import type { MetricHistoryMsg } from "drishti-common";
import {
  type DaemonDial,
  dialOverStdio,
  dialOverUnixSocket,
  firstFrame,
  framesUntil,
} from "./dialDaemon.testlib";
import {
  HISTORY_RING_FILE,
  HISTORY_RING_VERSION,
  loadHistoryRing,
} from "./historyRing";
import {
  isPreviousReleaseArmed,
  resolvePreviousRelease,
} from "./previousRelease";

const agentMain = join(import.meta.dir, "main.ts");

const temps: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const dial of dials.splice(0)) {
    try {
      await dial.dispose();
    } catch {
      // a link whose peer already died is fine
    }
  }
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const d of temps.splice(0)) {
    try {
      const prev = process.env.HOME;
      const prevXdg = process.env.XDG_STATE_HOME;
      process.env.HOME = d;
      process.env.XDG_STATE_HOME = join(d, ".local", "state");
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
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
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
    XDG_STATE_HOME: join(home, ".local", "state"),
    // both-or-neither: readBakedIdentity throws on half-pair (UW5)
    DRISHTI_AGENT_BUILD_ID: buildId,
    DRISHTI_AGENT_COMMIT_HASH: `e2e-commit-${buildId}`,
    ...extra,
  };
}

function spawnFront(home: string, buildId: string): ChildProcess {
  const child = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
    env: agentEnv(home, buildId),
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function waitFrontExit(front: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (front.exitCode !== null || front.signalCode !== null) {
      resolve();
      return;
    }
    front.once("exit", () => resolve());
    front.once("close", () => resolve());
  });
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

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.HOME;
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.HOME = home;
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
  }
}

function gatePid(home: string): number {
  return withHome(home, () => {
    const h = daemonHome({ app: "drishti", placement: "state" });
    // Pid-first law: Number.parseInt stops at the tab of a two-field gate.
    const body = readFileSync(h.gatePath, "utf8").trim();
    const pid = Number.parseInt(body, 10);
    if (!Number.isFinite(pid) || pid <= 0) throw new Error(`bad gate pid`);
    return pid;
  });
}

/** UW4: current agent writes two-field gates (pid + start time). */
function assertTwoFieldGate(home: string): void {
  withHome(home, () => {
    const h = daemonHome({ app: "drishti", placement: "state" });
    const body = readFileSync(h.gatePath, "utf8").trim();
    expect(body.includes("\t")).toBe(true);
    const [pidField, startField] = body.split("\t");
    expect(Number(pidField)).toBeGreaterThan(0);
    expect(Number(startField)).toBeGreaterThan(0);
  });
}

function ringPath(home: string): string {
  return withHome(home, () =>
    daemonHome({ app: "drishti", placement: "state" }).file(HISTORY_RING_FILE),
  );
}

function homeDir(home: string): string {
  return withHome(home, () =>
    daemonHome({ app: "drishti", placement: "state" }).dir,
  );
}

const dials: DaemonDial[] = [];

/** Dial a `--stdio` front child. Every dial is disposed in `afterEach` — the
 *  link owns a `Scope` holding the protocol's fibers now, so dropping one
 *  leaks them. */
async function dialFront(front: ChildProcess): Promise<DaemonDial> {
  if (front.stdin === null || front.stdout === null) {
    throw new Error("front missing stdio pipes");
  }
  const dial = await dialOverStdio(front.stdout, front.stdin);
  dials.push(dial);
  return dial;
}

/** The samples a subscriber has accumulated once it has seen `atLeast` of
 *  them — a snapshot RESETS the accumulator (it is the whole ring), a delta
 *  appends. */
async function collectHistorySamples(
  dial: DaemonDial,
  atLeast: number,
  timeoutMs = 15_000,
): Promise<{ t: number }[]> {
  const samples: { t: number }[] = [];
  const fold = (frames: readonly MetricHistoryMsg[]): boolean => {
    samples.length = 0;
    for (const frame of frames) {
      if (frame.kind === "snapshot") {
        samples.length = 0;
        samples.push(...frame.samples);
      } else if (frame.kind === "delta") {
        samples.push(frame.sample);
      }
    }
    return samples.length >= atLeast;
  };
  await framesUntil(dial.app.metricHistory.get({}), fold, timeoutMs);
  return samples;
}

describe("real window e2e", () => {
  it("done-when (a): last session exit, same pid adopted, ring intact via surface", async () => {
    const home = tempHome();
    const buildId = "e2e-adopt-build";

    const front1 = spawnFront(home, buildId);
    await waitForSocket(home);
    const pid1 = gatePid(home);
    assertTwoFieldGate(home);
    process.kill(pid1, 0);

    const client1 = await dialFront(front1);
    expect((await client1.control.hello()).buildId).toBe(buildId);

    // Wait for at least one live sample so the ring has served history.
    const before = await collectHistorySamples(client1, 1, 12_000);
    expect(before.length).toBeGreaterThan(0);

    // W2.2: wait for front1 EXIT event — not a fixed sleep.
    front1.kill("SIGTERM");
    await waitFrontExit(front1);
    process.kill(pid1, 0); // daemon still live

    const front2 = spawnFront(home, buildId);
    await waitForSocket(home);
    expect(gatePid(home)).toBe(pid1);

    const client2 = await dialFront(front2);
    const afterFrame = await firstFrame(client2.app.metricHistory.get({}));
    expect(afterFrame.kind).toBe("snapshot");
    const after = afterFrame.kind === "snapshot" ? afterFrame.samples : [];
    // Ring intact: every pre-disconnect sample timestamp is still present.
    const beforeTs = new Set(before.map((s) => s.t));
    const afterTs = new Set(after.map((s) => s.t));
    for (const t of beforeTs) {
      expect(afterTs.has(t)).toBe(true);
    }

    front2.kill("SIGTERM");
  }, 60_000);

  it("agent drain write: previous samples live, flushes on drain, successor serves them", async () => {
    // Agent-half of done-when (b): real drain write (no pre-plant). Parent
    // path (policy/pool/connector) is packages/app windowParent.e2e.test.ts.
    const home = tempHome();
    const previousBuildId = "synthetic-previous-build";
    const currentBuildId = "synthetic-current-build";

    const frontPrev = spawnFront(home, previousBuildId);
    await waitForSocket(home);
    const prevPid = gatePid(home);
    const clientPrev = await dialFront(frontPrev);
    expect((await clientPrev.control.hello()).buildId).toBe(previousBuildId);

    // Wait until LIVE samples exist (daemon sampled — not pre-planted).
    const liveSamples = await collectHistorySamples(clientPrev, 1, 12_000);
    expect(liveSamples.length).toBeGreaterThan(0);
    const liveTs = new Set(liveSamples.map((s) => s.t));

    // Force a ring file presence check after samples (periodic flush may lag;
    // drain must write regardless).
    const path = ringPath(home);
    const mtimeBefore = existsSync(path) ? statSync(path).mtimeMs : 0;

    // Drain via a separate unix-socket dial so the front's stdio transport is
    // not the one that dies with the daemon (the stdio link would fail closed).
    // drishti's OWN drain verb, so the persist verdict comes back as a VALUE.
    const sockPath = await waitForSocket(home);
    const sock = await dialOverUnixSocket(sockPath);
    try {
      const verdict = await sock.drain();
      expect(verdict).toEqual({ persisted: true });
    } finally {
      await sock.dispose();
    }

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

    // Drain write: ring file exists and contains the live sample timestamps.
    expect(existsSync(path)).toBe(true);
    const onDisk = loadHistoryRing(path);
    expect(onDisk.kind).toBe("ok");
    if (onDisk.kind === "ok") {
      const diskTs = new Set(onDisk.samples.map((s) => s.t));
      let recovered = 0;
      for (const t of liveTs) {
        if (diskTs.has(t)) recovered += 1;
      }
      expect(recovered).toBeGreaterThan(0);
      // mtime advanced or file newly created by drain flush.
      expect(statSync(path).mtimeMs).toBeGreaterThanOrEqual(mtimeBefore);
    }

    try {
      frontPrev.kill("SIGKILL");
    } catch {
      // gone
    }

    const frontSucc = spawnFront(home, currentBuildId);
    await waitForSocket(home);
    expect(gatePid(home)).not.toBe(prevPid);
    const clientSucc = await dialFront(frontSucc);
    const frame = await firstFrame(clientSucc.app.metricHistory.get({}));
    expect(frame.kind).toBe("snapshot");
    const servedTs = new Set(
      (frame.kind === "snapshot" ? frame.samples : []).map((s) => s.t),
    );
    let servedRecovered = 0;
    for (const t of liveTs) {
      if (servedTs.has(t)) servedRecovered += 1;
    }
    expect(servedRecovered).toBeGreaterThan(0);

    frontSucc.kill("SIGTERM");
  }, 90_000);

  it("F9 boot dispositions: garbage ⇒ unavailable + moved aside; v+1 ⇒ unavailable + left alone", async () => {
    // W2.9: no env persist override — 30s cadence is baked; standing
    // unavailable holds until the persist interval or drain (test finishes
    // well under 30s).
    {
      const home = tempHome();
      mkdirSync(homeDir(home), { recursive: true, mode: 0o700 });
      const path = ringPath(home);
      writeFileSync(path, '{"v":1,"samples":[', "utf8");

      const front = spawnFront(home, "e2e-disp-garbage");
      await waitForSocket(home);
      const client = await dialFront(front);
      const frame = await firstFrame(client.app.metricHistory.get({}));

      expect(frame).toEqual({ kind: "unavailable", reason: "corrupt" });
      expect(existsSync(path)).toBe(false);
      expect(
        readdirSync(homeDir(home)).filter((n) =>
          n.startsWith("history.ring.json.corrupt-"),
        ).length,
      ).toBe(1);

      // STANDING, not one-shot: a LATE subscriber reads the same disposition.
      const late = await firstFrame(client.app.metricHistory.get({}));
      expect(late).toEqual({ kind: "unavailable", reason: "corrupt" });

      front.kill("SIGTERM");
    }

    {
      const home = tempHome();
      mkdirSync(homeDir(home), { recursive: true, mode: 0o700 });
      const path = ringPath(home);
      const planted = {
        v: HISTORY_RING_VERSION + 1,
        samples: [{ t: 1, cpu: 0, mem: 0, swap: 0, disk: 0 }],
      };
      writeFileSync(path, JSON.stringify(planted), "utf8");

      const front = spawnFront(home, "e2e-disp-vplus");
      await waitForSocket(home);
      const client = await dialFront(front);
      const frame = await firstFrame(client.app.metricHistory.get({}));

      expect(frame).toEqual({ kind: "unavailable", reason: "unknown-version" });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(planted);

      const late = await firstFrame(client.app.metricHistory.get({}));
      expect(late.kind).toBe("unavailable");

      front.kill("SIGTERM");
    }
  }, 90_000);

  it("previous-release resolver is synthetic-unarmed until first daemon-capable tag", () => {
    expect(isPreviousReleaseArmed({ firstDaemonCapableReleaseTag: null })).toBe(
      false,
    );
    const r = resolvePreviousRelease({
      arming: { firstDaemonCapableReleaseTag: null },
      tags: { tags: ["v0.1.0"], storeForTag: () => "/nix/store/a" },
      currentStore: "/nix/store/b",
    });
    expect(r.kind).toBe("synthetic-unarmed");
  });
});
