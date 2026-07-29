/**
 * W6.2: final flush failure is typed on the drain throw AND a degraded
 * stream frame is proven by:
 *   1) a live subscriber that consumed a pre-failure frame first, then
 *   2) a post-failure subscriber that MUST connect and MUST read degraded.
 * Null frames / swallowed connect failures are test failures.
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
import { composeSurfaceContracts } from "@kolu/surface/define";
import { stdioLink } from "@kolu/surface/links/stdio";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import { controlCoreSurface, daemonHome } from "@kolu/surface-daemon";
import { surface } from "drishti-common";

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

type HistoryClient = {
  surface: {
    app: {
      metricHistory: {
        get: (
          i: Record<string, never>,
          o?: { signal?: AbortSignal },
        ) => Promise<
          AsyncIterable<{
            kind: string;
            reason?: string;
            samples?: unknown[];
          }>
        >;
      };
    };
    control: {
      core: {
        hello: () => Promise<unknown>;
        drain: () => Promise<void>;
      };
    };
  };
};

describe("W6.2 flush failure — degraded frame binds publish mutation", () => {
  it("pre-frame consumed, drain throws, post-fail subscriber READs degraded", async () => {
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
    const client = stdioLink<typeof agentDaemonContract>({
      read: front.stdout,
      write: front.stdin,
    }) as HistoryClient;

    await client.surface.control.core.hello();

    // Open LIVE stream and consume an initial pre-failure frame FIRST.
    const acLive = new AbortController();
    const liveStream = await client.surface.app.metricHistory.get(
      {},
      { signal: acLive.signal },
    );
    const liveFrames: { kind: string; reason?: string }[] = [];
    let sawPreFailure = false;
    const liveReader = (async () => {
      for await (const frame of liveStream) {
        liveFrames.push(frame);
        if (!sawPreFailure) {
          // First frame must be pre-failure (snapshot/delta/ok path).
          expect(frame.kind).not.toBe("degraded");
          sawPreFailure = true;
          continue;
        }
        if (frame.kind === "degraded") break;
      }
    })();

    // Wait until the pre-failure frame is actually consumed.
    const preDeadline = Date.now() + 12_000;
    while (!sawPreFailure && Date.now() < preDeadline) {
      await delay(20);
    }
    expect(sawPreFailure).toBe(true);

    // Make ring writes fail, then drain.
    chmodSync(dh.dir, 0o500);

    const sock = await unixSocketLink<typeof agentDaemonContract>({
      socketPath: dh.socketPath,
    });
    let drainCode: string | null = null;
    let drainData: unknown = null;
    try {
      await (
        sock.client as unknown as {
          surface: { control: { core: { drain: () => Promise<void> } } };
        }
      ).surface.control.core.drain();
      throw new Error("expected drain to throw on persist failure");
    } catch (err) {
      const e = err as { code?: string; data?: unknown };
      drainCode = e.code ?? null;
      drainData = e.data ?? null;
      if (e.code !== "DRISHTI_PERSIST_FAILED") {
        throw Object.assign(
          new Error(`unexpected drain error code: ${e.code}`),
          { cause: err },
        );
      }
    } finally {
      sock.dispose();
    }

    expect(drainCode).toBe("DRISHTI_PERSIST_FAILED");
    expect(drainData).toMatchObject({ persistFailed: true });

    // Wait for live subscriber to observe degraded publish.
    const liveDegDeadline = Date.now() + 3_000;
    while (
      !liveFrames.some((f) => f.kind === "degraded") &&
      Date.now() < liveDegDeadline
    ) {
      await delay(20);
    }

    // Post-failure subscriber MUST connect and MUST read a frame (W6.2).
    // No catch-to-null: connect failure fails the test.
    chmodSync(dh.dir, 0o700);
    await delay(30);
    const sock2 = await unixSocketLink<typeof agentDaemonContract>({
      socketPath: dh.socketPath,
    });
    let postFrame: { kind: string; reason?: string } | null = null;
    try {
      const ac2 = new AbortController();
      const stream2 = await (
        sock2.client as unknown as HistoryClient
      ).surface.app.metricHistory.get({}, { signal: ac2.signal });
      const d2 = Date.now() + 2_000;
      for await (const frame of stream2) {
        postFrame = frame;
        if (frame.kind === "degraded") break;
        if (Date.now() > d2) break;
      }
      ac2.abort();
    } finally {
      sock2.dispose();
    }

    acLive.abort();
    await Promise.race([liveReader, delay(300)]);

    // Live path: publishHistory must deliver degraded after pre-failure frame.
    const liveDegraded = liveFrames.find((f) => f.kind === "degraded");
    expect(liveDegraded).toBeDefined();
    expect(liveDegraded!.reason).toBe("persist-failed");

    // Post-fail path: null is a FAILURE (no optional branch).
    expect(postFrame).not.toBeNull();
    expect(postFrame!.kind).toBe("degraded");
    expect(postFrame!.reason).toBe("persist-failed");
  }, 60_000);
});
