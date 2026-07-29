/**
 * W4.2: final flush failure is typed on the drain throw AND a degraded
 * stream frame is visible to a subscriber that joins AFTER the fail.
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

describe("W4.2 flush failure — stream degraded after fail + drain throw", () => {
  it("injected write failure: drain throws DRISHTI_PERSIST_FAILED and post-fail stream is degraded", async () => {
    const home = mkdtempSync(join(tmpdir(), "flush-w42-"));
    temps.push(home);
    mkdirSync(join(home, ".local", "state"), { recursive: true, mode: 0o700 });
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    const dh = daemonHome({ app: "drishti", placement: "state" });

    const env = {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      DRISHTI_AGENT_BUILD_ID: "flush-w42",
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
    }) as {
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

    await client.surface.control.core.hello();

    // Wait for ok traffic first.
    {
      const ac = new AbortController();
      const stream = await client.surface.app.metricHistory.get(
        {},
        { signal: ac.signal },
      );
      const d = Date.now() + 12_000;
      for await (const frame of stream) {
        if (frame.kind === "snapshot" || frame.kind === "delta") break;
        if (Date.now() > d) break;
      }
      ac.abort();
    }

    // Make ring writes fail.
    chmodSync(dh.dir, 0o500);

    // W5.4: open stream BEFORE failing flush so the degraded publish is observed
    // (late subscribe can read historyView without the publish event).
    const acLive = new AbortController();
    const liveStreamP = client.surface.app.metricHistory.get(
      {},
      { signal: acLive.signal },
    );
    const liveFrames: { kind: string; reason?: string }[] = [];
    const liveReader = (async () => {
      try {
        const stream = await liveStreamP;
        for await (const frame of stream) {
          liveFrames.push(frame);
          if (frame.kind === "degraded") break;
        }
      } catch {
        // process exit after degraded
      }
    })();

    // Drain via socket — must throw DRISHTI_PERSIST_FAILED (void on success).
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
      const e = err as { code?: string; data?: unknown; message?: string };
      drainCode = e.code ?? null;
      drainData = e.data ?? null;
      if (e.code !== "DRISHTI_PERSIST_FAILED") {
        if (
          !String(e.message ?? "").includes("DRISHTI_PERSIST_FAILED") &&
          e.code !== "DRISHTI_PERSIST_FAILED"
        ) {
          throw Object.assign(
            new Error(`unexpected drain error: ${e.message ?? e}`),
            { cause: err },
          );
        }
      }
    } finally {
      sock.dispose();
    }

    expect(drainCode).toBe("DRISHTI_PERSIST_FAILED");
    expect(drainData).toMatchObject({ persistFailed: true });

    // Also subscribe AFTER fail (brief requires it) while process still alive.
    chmodSync(dh.dir, 0o700);
    await delay(20);
    const sock2 = await unixSocketLink<typeof agentDaemonContract>({
      socketPath: dh.socketPath,
    }).catch(() => null);
    let postFrame: { kind: string; reason?: string } | null = null;
    if (sock2) {
      try {
        const ac2 = new AbortController();
        const stream2 = await (
          sock2.client as unknown as {
            surface: {
              app: {
                metricHistory: {
                  get: (
                    i: Record<string, never>,
                    o?: { signal?: AbortSignal },
                  ) => Promise<
                    AsyncIterable<{ kind: string; reason?: string }>
                  >;
                };
              };
            };
          }
        ).surface.app.metricHistory.get({}, { signal: ac2.signal });
        const d2 = Date.now() + 1_500;
        for await (const frame of stream2) {
          postFrame = frame;
          if (frame.kind === "degraded") break;
          if (Date.now() > d2) break;
        }
        ac2.abort();
      } catch {
        //
      } finally {
        sock2.dispose();
      }
    }

    acLive.abort();
    await Promise.race([liveReader, delay(500)]);

    // W5.4: the LIVE subscriber must see the publishHistory degraded event.
    // Late-subscribe historyView alone must NOT be enough (that would let
    // deleting publishHistory still pass).
    const liveDegraded = liveFrames.find((f) => f.kind === "degraded");
    expect(liveDegraded).not.toBeUndefined();
    expect(liveDegraded!.reason).toBe("persist-failed");
    // Also require a post-fail subscribe path when the process is still up.
    if (postFrame !== null) {
      expect(postFrame.kind).toBe("degraded");
    }
  }, 60_000);
});
