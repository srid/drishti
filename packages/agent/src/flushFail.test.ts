/**
 * W6.2: a failed FINAL flush is reported as a VALUE on drishti's own drain
 * verb, and a degraded stream frame is proven by:
 *   1) a live subscriber that consumed a pre-failure frame first, then
 *   2) a post-failure subscriber that MUST connect and MUST read degraded.
 * Null frames / swallowed connect failures are test failures.
 *
 * The persist verdict does NOT ride the frozen control-core drain any more.
 * That channel declares no error, so a rejecting `onDrain` is a DEFECT in this
 * protocol epoch — and a full disk is not a broken daemon. drishti owns
 * `daemon.ring.drain` for exactly this, and it ANSWERS rather than throws.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { daemonHome } from "@kolu/surface-daemon";
import type { MetricHistoryMsg } from "drishti-common";
import {
  collect,
  dialOverStdio,
  dialOverUnixSocket,
  framesUntil,
} from "./dialDaemon.testlib";

const agentMain = join(import.meta.dir, "main.ts");

const temps: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      //
    }
  }
  for (const d of temps.splice(0)) {
    try {
      chmodSync(d, 0o700);
      const state = join(d, ".local", "state", "drishti");
      try {
        chmodSync(state, 0o700);
      } catch {
        //
      }
      process.env.HOME = d;
      process.env.XDG_STATE_HOME = join(d, ".local", "state");
      const home = daemonHome({ app: "drishti", placement: "state" });
      if (existsSync(home.gatePath)) {
        const pid = Number.parseInt(readFileSync(home.gatePath, "utf8"), 10);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            //
          }
        }
      }
    } catch {
      //
    }
    rmSync(d, { recursive: true, force: true });
  }
  await delay(50);
});

describe("W6.2 flush failure — degraded frame binds publish mutation", () => {
  it("pre-frame consumed, drain ANSWERS persisted:false, post-fail subscriber READs degraded", async () => {
    const home = mkdtempSync(join(tmpdir(), "flush-w62-"));
    temps.push(home);
    mkdirSync(join(home, ".local", "state"), { recursive: true, mode: 0o700 });
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    const dh = daemonHome({ app: "drishti", placement: "state" });

    const env = {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      DRISHTI_AGENT_BUILD_ID: "flush-w62",
      DRISHTI_AGENT_COMMIT_HASH: "e2e-commit-flush-w62",
    };
    const front = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(front);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(dh.socketPath) && existsSync(dh.gatePath)) break;
      await delay(50);
    }
    expect(existsSync(dh.socketPath)).toBe(true);
    if (front.stdin === null || front.stdout === null) {
      throw new Error("no stdio");
    }
    const client = await dialOverStdio(front.stdout, front.stdin);

    await client.control.hello();

    // Open a LIVE subscription and let it consume a pre-failure frame FIRST.
    // Teardown is fiber interruption now — no AbortController anywhere.
    const live = collect<MetricHistoryMsg>(client.app.metricHistory.get({}));
    const preDeadline = Date.now() + 12_000;
    while (live.frames.length === 0 && Date.now() < preDeadline) {
      await delay(20);
    }
    expect(live.frames.length).toBeGreaterThan(0);
    // The first frame must be pre-failure (the ok/standing path).
    expect(live.frames[0]?.kind).not.toBe("degraded");

    // Make ring writes fail, then drain.
    chmodSync(dh.dir, 0o500);

    const sock = await dialOverUnixSocket(dh.socketPath);
    let verdict: { persisted: boolean; error?: string };
    try {
      verdict = await sock.drain();
    } finally {
      await sock.dispose();
    }

    // The verdict is a VALUE on a call that SUCCEEDED — the drain happened,
    // and the daemon says its final write did not land.
    expect(verdict.persisted).toBe(false);
    expect(typeof verdict.error).toBe("string");
    expect(verdict.error?.length ?? 0).toBeGreaterThan(0);

    // Wait for the live subscriber to observe the degraded publish.
    const liveDegDeadline = Date.now() + 3_000;
    while (
      !live.frames.some((f) => f.kind === "degraded") &&
      Date.now() < liveDegDeadline
    ) {
      await delay(20);
    }

    // Post-failure subscriber MUST connect and MUST read a frame (W6.2).
    // No catch-to-null: connect failure fails the test.
    chmodSync(dh.dir, 0o700);
    await delay(30);
    const sock2 = await dialOverUnixSocket(dh.socketPath);
    let postFrames: MetricHistoryMsg[];
    try {
      postFrames = await framesUntil(
        sock2.app.metricHistory.get({}),
        (frames) => frames.some((f) => f.kind === "degraded"),
        5_000,
      );
    } finally {
      await sock2.dispose();
    }

    await live.stop();
    await client.dispose();

    // Live path: publishHistory must deliver degraded after the pre-failure frame.
    const liveDegraded = live.frames.find((f) => f.kind === "degraded");
    expect(liveDegraded).toBeDefined();
    expect(liveDegraded).toMatchObject({
      kind: "degraded",
      reason: "persist-failed",
    });

    // Post-fail path: a standing degraded disposition for a LATE subscriber.
    const postDegraded = postFrames.find((f) => f.kind === "degraded");
    expect(postDegraded).toBeDefined();
    expect(postDegraded).toMatchObject({
      kind: "degraded",
      reason: "persist-failed",
    });
  }, 60_000);
});
