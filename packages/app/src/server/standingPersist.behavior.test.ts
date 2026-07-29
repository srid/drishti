/**
 * W6.3: automatic-path behavior for drained-with-persist-failure.
 *
 * Real processes: failing final flush → replaced → successor adopt →
 * projection STILL shows drained-with-persist-failure. Successful renew
 * clears it. MUTATION: raw `drain = probe.fireDrain` ⇒ this test reds
 * (standing never set).
 *
 * Gated: needs KOLU_DAEMON_TESTS=1 + flake agent fixture (like pool e2e).
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { call } from "@orpc/server";
import {
  agentBinaryCache,
  directAgentDerivation,
} from "@kolu/surface-remote";
import { daemonHome } from "@kolu/surface-daemon";
import { buildAdminRouter } from "./admin-router";
import { buildHostPool, type HostPool } from "./hostRegistry";

const daemonTestsEnabled = process.env.KOLU_DAEMON_TESTS === "1";
const agentMain = join(import.meta.dir, "../../../agent/src/main.ts");

const temps: string[] = [];
const children: ChildProcess[] = [];
const pools: HostPool[] = [];

afterEach(async () => {
  for (const p of pools.splice(0)) {
    try {
      await p.destroyAll();
    } catch {
      //
    }
  }
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
      try {
        chmodSync(join(d, ".local", "state", "drishti"), 0o700);
      } catch {
        //
      }
      rmSync(d, { recursive: true, force: true });
    } catch {
      //
    }
  }
  await delay(50);
});

async function fixtureAgent(): Promise<{
  drvPath: string;
  system: string;
  buildId: string;
  binaryCache: ReturnType<typeof agentBinaryCache>;
} | null> {
  try {
    const sysProc = Bun.spawn(
      ["nix", "eval", "--impure", "--raw", "--expr", "builtins.currentSystem"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const system = (await new Response(sysProc.stdout).text()).trim();
    await sysProc.exited;
    if (!system) return null;
    const binaryCache = agentBinaryCache({
      substituters: ["https://cache.nixos.org"],
      trustedPublicKeys: [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=",
      ],
    });
    const drvsProc = Bun.spawn(["nix", "eval", "--raw", ".#agentDrvsJson"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const drvsJson = (await new Response(drvsProc.stdout).text()).trim();
    await drvsProc.exited;
    const drvs = JSON.parse(drvsJson) as Record<string, string>;
    const drvPath = drvs[system];
    if (!drvPath?.endsWith(".drv")) return null;
    await Bun.spawn(["nix-store", "-r", drvPath], {
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    const idsProc = Bun.spawn(["nix", "eval", "--raw", ".#agentBuildIdsJson"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const idsJson = (await new Response(idsProc.stdout).text()).trim();
    await idsProc.exited;
    const ids = JSON.parse(idsJson) as Record<string, string>;
    const buildId = ids[system];
    if (!buildId) return null;
    return { drvPath, system, buildId, binaryCache };
  } catch {
    return null;
  }
}

function writeSshShim(binDir: string): void {
  const shim = join(binDir, "ssh");
  writeFileSync(
    shim,
    `#!/usr/bin/env bash
echo "ssh shim should not run" >&2
exit 97
`,
    { mode: 0o755 },
  );
}

describe("W6.3 standing persist-failure automatic path", () => {
  it.skipIf(!daemonTestsEnabled)(
    "failing flush → replaced → adopt keeps standing; renew clears",
    async () => {
      const fixture = await fixtureAgent();
      if (fixture === null) {
        throw new Error("fixtureAgent required under KOLU_DAEMON_TESTS=1");
      }

      const home = mkdtempSync(join(tmpdir(), "drishti-stand-e2e-"));
      temps.push(home);
      mkdirSync(join(home, ".local", "state"), {
        recursive: true,
        mode: 0o700,
      });
      const binDir = join(home, "bin");
      mkdirSync(binDir, { recursive: true });
      writeSshShim(binDir);

      const previousBuildId = `prev-${fixture.buildId.slice(0, 8)}`;
      const currentBuildId = fixture.buildId;

      const prevEnv = {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: join(home, ".local", "state"),
        DRISHTI_AGENT_BUILD_ID: previousBuildId,
        DRISHTI_AGENT_COMMIT_HASH: `e2e-${previousBuildId}`,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      };
      const frontPrev = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
        env: prevEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(frontPrev);

      process.env.HOME = home;
      process.env.XDG_STATE_HOME = join(home, ".local", "state");
      const dh = daemonHome({ app: "drishti", placement: "state" });
      const sockDeadline = Date.now() + 20_000;
      while (Date.now() < sockDeadline) {
        if (existsSync(dh.socketPath) && existsSync(dh.gatePath)) break;
        await delay(50);
      }
      expect(existsSync(dh.socketPath)).toBe(true);
      await delay(2500);
      // Fail final flush: replace the ring FILE with a DIRECTORY so atomic
      // write hits EISDIR. State dir stays 0700 for successor daemonHome.
      const ringPath = dh.file("history.ring.json");
      if (existsSync(ringPath)) {
        unlinkSync(ringPath);
      }
      mkdirSync(ringPath, { mode: 0o700 });

      process.env.DRISHTI_AGENT_BUILD_ID = currentBuildId;
      process.env.DRISHTI_AGENT_COMMIT_HASH = `e2e-${currentBuildId}`;
      process.env.DRISHTI_E2E_HOME = home;
      process.env.DRISHTI_E2E_XDG_STATE_HOME = join(home, ".local", "state");
      process.env.DRISHTI_E2E_BUILD_ID = currentBuildId;
      process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

      const host = "localhost";
      const hostsFile = join(home, "hosts.json");
      writeFileSync(hostsFile, JSON.stringify({ hosts: [] }));
      const pool = buildHostPool({
        initialHosts: [host],
        hostsFile,
        buildIdBySystem: { [fixture.system]: currentBuildId },
        resolveDrvPath: async () => ({
          derivation: directAgentDerivation(
            fixture.drvPath,
            fixture.binaryCache,
          ),
          system: fixture.system,
        }),
      });
      pools.push(pool);
      const session = pool.getSession(host)!;

      // W7.5: no message-prefix matching; drain evidence is structured below.
      try {
        await session.pin();
      } catch {
        // replaced rejects pin
      } finally {
        // Remove EISDIR trap so successor can rewrite the ring file.
        try {
          rmSync(ringPath, { recursive: true, force: true });
        } catch {
          //
        }
      }

      // Successor connect after drain.
      const advDeadline = Date.now() + 90_000;
      while (Date.now() < advDeadline) {
        if (session.currentState().phase === "connected") break;
        await delay(100);
      }
      expect(session.currentState().phase).toBe("connected");

      // STANDING: persist failure must still project after successor adopt.
      const standDeadline = Date.now() + 10_000;
      let standing = session.convergence();
      while (Date.now() < standDeadline) {
        standing = session.convergence();
        if (standing?.kind === "drained-with-persist-failure") break;
        await delay(50);
      }
      expect(standing?.kind).toBe("drained-with-persist-failure");

      // Ensure ring path is a writable file for renew flush.
      try {
        rmSync(ringPath, { recursive: true, force: true });
      } catch {
        //
      }

      const admin = buildAdminRouter({ pool });
      // biome-ignore lint/suspicious/noExplicitAny: oRPC router
      const hostsProc = (admin.router as any).surface.admin.hosts;
      const renewResult = await call(hostsProc.renew, { host });
      expect(renewResult).toEqual({ ok: true });

      // After successful renew, standing failure is cleared.
      const clearDeadline = Date.now() + 30_000;
      while (Date.now() < clearDeadline) {
        const c = session.convergence();
        if (c === null || c.kind !== "drained-with-persist-failure") break;
        await delay(50);
      }
      const after = session.convergence();
      expect(
        after === null || after.kind !== "drained-with-persist-failure",
      ).toBe(true);

      try {
        session.destroy();
      } catch {
        //
      }
      await pool.destroyAll();
      const idx = pools.indexOf(pool);
      if (idx >= 0) pools.splice(idx, 1);
    },
    180_000,
  );
});
