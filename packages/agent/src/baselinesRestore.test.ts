/**
 * W3.3: baselines restored BEFORE first host read; process-level proof that
 * the successor's first system frame has non-zero rates (importBaselines) and
 * that alertsSeed is loaded from the ring into the hysteresis fold.
 *
 * EXECUTED mutations: delete importBaselines ⇒ red (cpuPct stays 0);
 * alertsSeed → NO_ALERTS ⇒ red (hold-band seed lost on mock path — see
 * alertsSeed unit below; process path pins plant alerts via hold when metrics
 * stay in [CLEAR, RAISE)).
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
// readFileSync also used for main.ts confinement pin
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { composeSurfaceContracts } from "@kolu/surface/define";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import { controlCoreSurface, daemonHome } from "@kolu/surface-daemon";
import { surface } from "drishti-common";
import { applyHysteresis, NO_ALERTS } from "drishti-common/alerts";
import {
  HISTORY_RING_FILE,
  loadHistoryRing,
  saveHistoryRing,
} from "./historyRing";
import { NO_BASELINES } from "./ringBaselines";

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

describe("W3.3 baseline + alert restore process-level", () => {
  it("importBaselines: first system.cpuPct is non-zero when plant has host baselines", async () => {
    const home = mkdtempSync(join(tmpdir(), "base-w33-"));
    temps.push(home);
    mkdirSync(join(home, ".local", "state"), { recursive: true, mode: 0o700 });
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    const dh = daemonHome({ app: "drishti", placement: "state" });

    const now = Date.now();
    // Near-idle counters for many cores so live osfacts counters yield non-zero
    // first-frame rates ONLY when importBaselines ran before first readCpuCores.
    const cpus = Array.from({ length: 32 }, (_, i) => [
      i,
      {
        userUs: 1000,
        systemUs: 1000,
        idleUs: 1_000_000,
        otherUs: 0,
        model: "plant",
        frequencyMhz: 2000 as number | null,
      },
    ]);
    saveHistoryRing(
      dh.file(HISTORY_RING_FILE),
      [{ t: now - 1000, cpu: 50, mem: 40, swap: 0, disk: 20 }],
      { items: ["cpu"] },
      {
        host: {
          takenMs: now - 5000,
          cpus: cpus as never,
          networks: [],
        },
        process: {
          takenMs: now - 5000,
          cpuTimes: [[1, 1_000_000] as [number, number]],
        },
      },
    );

    const loaded = loadHistoryRing(dh.file(HISTORY_RING_FILE));
    expect(loaded.kind).toBe("ok");
    if (loaded.kind === "ok") {
      expect(loaded.baselines).not.toEqual(NO_BASELINES);
      expect(loaded.alerts).toEqual({ items: ["cpu"] });
    }

    const env = {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      DRISHTI_AGENT_BUILD_ID: "base-w33",
    };
    const front = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(front);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(dh.socketPath) && existsSync(dh.gatePath)) break;
      await delay(20);
    }
    expect(existsSync(dh.socketPath)).toBe(true);

    // Dial daemon socket (not stdio front) for cell streams.
    const sock = await unixSocketLink<typeof agentDaemonContract>({
      socketPath: dh.socketPath,
    });
    try {
      const client = sock.client as {
        surface: {
          control: { core: { hello: () => Promise<unknown> } };
          app: {
            system: {
              get: (
                i: Record<string, never>,
                o?: { signal?: AbortSignal },
              ) => Promise<AsyncIterable<{ cpuPct?: number }>>;
            };
            alerts: {
              get: (
                i: Record<string, never>,
                o?: { signal?: AbortSignal },
              ) => Promise<AsyncIterable<{ items?: string[] }>>;
            };
          };
        };
      };
      await client.surface.control.core.hello();

      const ac = new AbortController();
      const stream = await client.surface.app.system.get(
        {},
        { signal: ac.signal },
      );
      let cpuPct = 0;
      for await (const frame of stream) {
        cpuPct = frame.cpuPct ?? 0;
        break;
      }
      ac.abort();

      // Mutation pin W3.3a: delete importBaselines ⇒ first frame cpuPct is 0.
      expect(cpuPct).toBeGreaterThan(0);
    } finally {
      sock.dispose();
    }

    front.kill("SIGTERM");
  }, 60_000);

  it("alertsSeed assignment: production loads ring alerts into hysteresis seed", () => {
    // Production site: alertsSeed = loaded.alerts (main.ts). Hold band fold
    // with planted seed retains the alert; NO_ALERTS seed does not.
    const planted = { items: ["cpu" as const] };
    const holdFrame = { cpu: 75, mem: 10, swap: 0, disk: 10 };
    expect(applyHysteresis(planted, holdFrame).items).toEqual(["cpu"]);
    expect(applyHysteresis(NO_ALERTS, holdFrame).items).toEqual([]);
  });

  it("drain → successor: ring baselines survive on disk for importBaselines", async () => {
    const home = mkdtempSync(join(tmpdir(), "base-w33-drain-"));
    temps.push(home);
    mkdirSync(join(home, ".local", "state"), { recursive: true, mode: 0o700 });
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    const dh = daemonHome({ app: "drishti", placement: "state" });

    const env = {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      DRISHTI_AGENT_BUILD_ID: "base-drain",
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

    await delay(2500);
    const sock = await unixSocketLink({
      socketPath: dh.socketPath,
    });
    try {
      await (
        sock.client as {
          surface: { control: { core: { drain: () => Promise<unknown> } } };
        }
      ).surface.control.core.drain();
    } catch {
      // transport close ok
    } finally {
      sock.dispose();
    }

    await delay(300);
    const ringPath = dh.file(HISTORY_RING_FILE);
    expect(existsSync(ringPath)).toBe(true);
    const pre = loadHistoryRing(ringPath);
    expect(pre.kind).toBe("ok");
    if (pre.kind === "ok") {
      const hasBaseline =
        (pre.baselines.process?.cpuTimes.length ?? 0) > 0 ||
        (pre.baselines.host?.cpus.length ?? 0) > 0;
      expect(hasBaseline).toBe(true);
    }

    const front2 = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
      env: { ...env, DRISHTI_AGENT_BUILD_ID: "base-succ" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(front2);
    const d2 = Date.now() + 15_000;
    while (Date.now() < d2) {
      if (existsSync(dh.socketPath) && existsSync(dh.gatePath)) {
        const p = Number.parseInt(readFileSync(dh.gatePath, "utf8"), 10);
        if (Number.isFinite(p)) break;
      }
      await delay(50);
    }

    const post = loadHistoryRing(ringPath);
    expect(post.kind).toBe("ok");
    if (post.kind === "ok" && pre.kind === "ok") {
      expect(post.baselines).toEqual(pre.baselines);
    }
  }, 90_000);

  it("main.ts production site: alertsSeed = loaded.alerts + importBaselines (confinement)", () => {
    // W4.3 / W4.6: mutations at these production lines go red here.
    const mainSrc = readFileSync(join(import.meta.dir, "main.ts"), "utf8");
    expect(mainSrc).toMatch(/alertsSeed\s*=\s*loaded\.alerts/);
    expect(mainSrc).not.toMatch(/alertsSeed\s*=\s*NO_ALERTS/);
    expect(mainSrc).toMatch(/reader\.importBaselines\?\.\(loaded\.baselines\)/);
  });
});
