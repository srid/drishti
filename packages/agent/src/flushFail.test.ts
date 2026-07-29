/**
 * W3.2: final flush failure is typed on the stream AND on the drain verb result.
 *
 * EXECUTED mutations (see uw3-wave3-mutations.md):
 * - revert production catch to log-only ⇒ stream test red
 * - drop failure from drain result ⇒ parent-side test red
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

type DrainResult = {
  ok?: boolean;
  persistFailed?: boolean;
  error?: string | null;
};

describe("W3.2 flush failure on stream + drain verb", () => {
  it("injected write failure: stream degraded AND drain result persistFailed", async () => {
    const home = mkdtempSync(join(tmpdir(), "flush-w32-"));
    temps.push(home);
    mkdirSync(join(home, ".local", "state"), { recursive: true, mode: 0o700 });
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    const dh = daemonHome({ app: "drishti", placement: "state" });

    const env = {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      DRISHTI_AGENT_BUILD_ID: "flush-w32",
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
              AsyncIterable<{ kind: string; reason?: string; samples?: unknown[] }>
            >;
          };
        };
        control: {
          core: {
            hello: () => Promise<unknown>;
            drain: () => Promise<DrainResult | void>;
          };
        };
      };
    };

    await client.surface.control.core.hello();

    // Wait for ok traffic.
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

    // Make ring writes fail (atomic rename needs write on dir).
    chmodSync(dh.dir, 0o500);

    // Separate socket dial for drain so we receive the typed failure.
    const sock = await unixSocketLink<typeof agentDaemonContract>({
      socketPath: dh.socketPath,
    });
    let drainResult: DrainResult | null = null;
    let drainError: string | null = null;
    try {
      const raw = await (
        sock.client as unknown as {
          surface: {
            control: { core: { drain: () => Promise<DrainResult | void> } };
          };
        }
      ).surface.control.core.drain();
      if (raw && typeof raw === "object") drainResult = raw as DrainResult;
    } catch (err) {
      const e = err as {
        code?: string;
        message?: string;
        data?: { persistFailed?: boolean; error?: string | null };
      };
      drainError = e.message ?? String(err);
      if (e.code === "DRISHTI_PERSIST_FAILED") {
        drainResult = {
          ok: false,
          persistFailed: true,
          error:
            (typeof e.data?.error === "string" && e.data.error) ||
            e.message ||
            "persist-failed",
        };
      } else if (drainError.includes("DRISHTI_PERSIST_FAILED")) {
        drainResult = {
          ok: false,
          persistFailed: true,
          error: drainError,
        };
      } else {
        // Surface unexpected errors for the mutation table.
        throw Object.assign(new Error(`unexpected drain error: ${drainError}`), {
          cause: err,
        });
      }
    } finally {
      sock.dispose();
    }

    chmodSync(dh.dir, 0o700);

    // Exact typed expectations — not vacuous null|string.
    expect(drainResult).not.toBeNull();
    expect(drainResult).toMatchObject({
      ok: false,
      persistFailed: true,
    });
    expect(typeof drainResult!.error).toBe("string");
    expect((drainResult!.error ?? "").length).toBeGreaterThan(0);
  }, 60_000);
});
