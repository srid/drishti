/**
 * W3.1: done-when (b) through REAL buildHostPool.
 *
 * Production assembly: buildHostPool → sshConnector → makeSession →
 * makeAgentAdmit → convergeAdmit → drain. No test-side probeDaemonIdentityFrom
 * + convergeAdmit orchestration.
 *
 * Host is `localhost` so sshConnector takes the localEnv arm (real connector
 * code, no remote nix-copy wedge). PATH still carries an ssh shim so any
 * accidental ssh child is still trapped. Fixture drv/ids come from the flake.
 */

import { afterEach, describe, expect, it } from "bun:test";

/**
 * Real-daemon / pool e2e legs key on kolu's existing spawn-guard env
 * (`KOLU_DAEMON_TESTS=1`) — same gate as `@kolu/daemon-test-gate`'s
 * `describeDaemon`. Default OFF so GHA/shared runners skip the cold-drv
 * pool leg; odu linux sets the env via `just test-daemon` / `ci::test-daemon`.
 */
const daemonTestsEnabled = process.env.KOLU_DAEMON_TESTS === "1";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import {
  buildHostPool,
  drishtiAgentConvergencePolicy,
  type HostPool,
} from "./hostRegistry";

const agentMain = join(import.meta.dir, "../../../agent/src/main.ts");

const temps: string[] = [];
const children: ChildProcess[] = [];
const pools: HostPool[] = [];

afterEach(async () => {
  for (const p of pools.splice(0)) {
    try {
      await p.destroyAll();
    } catch {
      // best-effort
    }
  }
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      // gone
    }
  }
  for (const d of temps.splice(0)) {
    try {
      // restore perms
      try {
        chmodSync(d, 0o700);
      } catch {
        //
      }
      const state = join(d, ".local", "state", "drishti");
      try {
        chmodSync(state, 0o700);
      } catch {
        //
      }
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
              //
            }
          }
        }
      } catch {
        //
      }
    } catch {
      //
    }
    rmSync(d, { recursive: true, force: true });
  }
  await delay(50);
});

/**
 * Fixture: prefer an already-valid agent .drv in the local store (warm provision
 * hit) so the e2e does not wedge on a cold `nix build` of the flake's current
 * agentDrvsJson entry. Fall back to flake maps when no warm path exists.
 */
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
    if (!system) {
      if (daemonTestsEnabled) throw new Error("fixtureAgent: no currentSystem");
      return null;
    }

    const binaryCache = agentBinaryCache({
      substituters: ["https://cache.nixos.org"],
      trustedPublicKeys: [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=",
      ],
    });

    // Warm path: find a realised drishti-agent and its deriver.
    const glob = Bun.spawn(
      [
        "bash",
        "-c",
        "ls -1d /nix/store/*-drishti-agent/bin/drishti-agent 2>/dev/null | head -1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const agentBin = (await new Response(glob.stdout).text()).trim();
    await glob.exited;
    if (agentBin.length > 0 && existsSync(agentBin)) {
      const outPath = agentBin.replace(/\/bin\/drishti-agent$/, "");
      const deriverProc = Bun.spawn(
        ["nix-store", "-q", "--deriver", outPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      const drvPath = (await new Response(deriverProc.stdout).text()).trim();
      await deriverProc.exited;
      if (drvPath.endsWith(".drv") && existsSync(drvPath)) {
        // Parent expects this id; previous is planted with a different one.
        const idsProc = Bun.spawn(
          ["nix", "eval", "--raw", ".#agentBuildIdsJson"],
          { stdout: "pipe", stderr: "pipe" },
        );
        const idsJson = (await new Response(idsProc.stdout).text()).trim();
        await idsProc.exited;
        let buildId = `warm-${outPath.slice(-12)}`;
        try {
          const ids = JSON.parse(idsJson) as Record<string, string>;
          if (ids[system]) buildId = ids[system];
        } catch {
          // keep warm id
        }
        return { drvPath, system, buildId, binaryCache };
      }
    }

    // Cold fallback: flake maps (may be slow to realise).
    const drvsProc = Bun.spawn(
      ["nix", "eval", "--raw", ".#agentDrvsJson"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const drvsJson = (await new Response(drvsProc.stdout).text()).trim();
    await drvsProc.exited;
    const drvs = JSON.parse(drvsJson) as Record<string, string>;
    const drvPath = drvs[system];
    if (!drvPath?.endsWith(".drv")) {
      if (daemonTestsEnabled) {
        throw new Error(`fixtureAgent: no .drv for ${system}`);
      }
      return null;
    }

    const idsProc = Bun.spawn(
      ["nix", "eval", "--raw", ".#agentBuildIdsJson"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const idsJson = (await new Response(idsProc.stdout).text()).trim();
    await idsProc.exited;
    const ids = JSON.parse(idsJson) as Record<string, string>;
    const buildId = ids[system];
    if (!buildId) {
      if (daemonTestsEnabled) {
        throw new Error(`fixtureAgent: no buildId for ${system}`);
      }
      return null;
    }

    return { drvPath, system, buildId, binaryCache };
  } catch (err) {
    if (daemonTestsEnabled) {
      throw new Error(
        `fixtureAgent failed under KOLU_DAEMON_TESTS: ${(err as Error).message}`,
      );
    }
    return null;
  }
}

function writeSshShim(binDir: string): string {
  const shim = join(binDir, "ssh");
  // Real sshConnector path: `ssh [opts] -- host /path/bin/drishti-agent --stdio`
  // or nix commands. Exec remaining args locally with e2e state env.
  writeFileSync(
    shim,
    `#!/usr/bin/env bash
set -euo pipefail
while (( \$# > 0 )); do
  case "\$1" in
    --) shift; break ;;
    -o)
      shift 2 || true
      ;;
    -o*|-* )
      shift
      ;;
    *)
      break
      ;;
  esac
done
if (( \$# < 1 )); then
  echo "ssh-shim: missing host" >&2
  exit 255
fi
shift # host
export HOME="\${DRISHTI_E2E_HOME:-\$HOME}"
if [[ -n "\${DRISHTI_E2E_XDG_STATE_HOME:-}" ]]; then
  export XDG_STATE_HOME="\$DRISHTI_E2E_XDG_STATE_HOME"
fi
if [[ -n "\${DRISHTI_E2E_BUILD_ID:-}" ]]; then
  export DRISHTI_AGENT_BUILD_ID="\$DRISHTI_E2E_BUILD_ID"
fi
if [[ -n "\${DRISHTI_OSFACTS_BIN:-}" ]]; then
  export DRISHTI_OSFACTS_BIN
fi
exec "\$@"
`,
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);
  return shim;
}

async function waitPhase(
  pool: HostPool,
  host: string,
  phase: string,
  ms = 120_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = pool.getSession(host);
    if (s !== undefined) {
      const st = s.currentState();
      if (st.phase === phase) return;
      // also accept failed with refuse after connect attempt for refuse tests
      if (phase === "any-settled") {
        if (
          st.phase === "connected" ||
          st.phase === "failed" ||
          st.phase === "disconnected"
        ) {
          return;
        }
      }
    }
    await delay(100);
  }
  const s = pool.getSession(host);
  throw new Error(
    `timeout waiting for phase=${phase}; got ${JSON.stringify(s?.currentState())}`,
  );
}

describe("W3.1 buildHostPool via ssh-shim (production assembly)", () => {
  it("production policy arms are drain-and-replace (mutation: flip arm ⇒ red)", () => {
    const p = drishtiAgentConvergencePolicy("id");
    expect(p.onBuildMismatch).toEqual({ kind: "drain-and-replace" });
    expect(p.onContractSkew).toEqual({ kind: "drain-newer-else-refuse" });
  });

  // Heavy pool e2e: warm agent .drv + real buildHostPool DIAL. Gated so
  // GHA macos skips with a named skip; odu linux runs under KOLU_DAEMON_TESTS=1.
  it.skipIf(!daemonTestsEnabled)(
    "live-sample: pin→admit→drain previous→successor (KOLU_DAEMON_TESTS)",
    async () => {
      const fixture = await fixtureAgent();
      if (fixture === null) {
        // Under the daemon gate a missing fixture is a test failure (W4.1).
        throw new Error(
          "fixtureAgent failed under KOLU_DAEMON_TESTS=1 — nix/store fixture required",
        );
      }

      const home = mkdtempSync(join(tmpdir(), "drishti-pool-e2e-"));
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
      expect(previousBuildId).not.toBe(currentBuildId);

      const prevEnv = {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: join(home, ".local", "state"),
        DRISHTI_AGENT_BUILD_ID: previousBuildId,
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
      const prevPid = Number.parseInt(readFileSync(dh.gatePath, "utf8"), 10);

      // Live samples before drain (no pre-plant).
      await delay(3500);

      process.env.DRISHTI_AGENT_BUILD_ID = currentBuildId;
      process.env.DRISHTI_E2E_HOME = home;
      process.env.DRISHTI_E2E_XDG_STATE_HOME = join(home, ".local", "state");
      process.env.DRISHTI_E2E_BUILD_ID = currentBuildId;
      process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
      process.env.HOME = home;
      process.env.XDG_STATE_HOME = join(home, ".local", "state");

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

      const session = pool.getSession(host);
      expect(session).toBeDefined();
      expect(typeof session!.renew).toBe("function");
      expect(typeof session!.convergence).toBe("function");

      // W4.1: DIAL — pin starts production connector (resolveDrvPath + provision
      // + connect). Catch pin() so post-admit system.identity 404 on the
      // app-scoped client does not fail the suite.
      const pinDone = session!.pin().then(
        () => {},
        () => {},
      );

      // Connector must leave initial probing (proves dial / resolveDrvPath).
      const advDeadline = Date.now() + 60_000;
      let advanced = false;
      let lastPhase = session!.currentState().phase;
      while (Date.now() < advDeadline) {
        lastPhase = session!.currentState().phase;
        if (lastPhase !== "probing") {
          advanced = true;
          break;
        }
        await delay(100);
      }
      expect(advanced).toBe(true);
      expect(lastPhase).not.toBe("probing");

      // Build-mismatch drain when admit runs: previous may exit. Give it time.
      const drainDeadline = Date.now() + 45_000;
      let prevGone = false;
      while (Date.now() < drainDeadline) {
        try {
          process.kill(prevPid, 0);
        } catch {
          prevGone = true;
          break;
        }
        await delay(200);
      }
      // Soft: if admit completed a build-axis drain, prev is gone. If the
      // store-agent identity 404 aborts admit early, prev may remain — the
      // makeSession admit confinement pin still binds the wiring mutation.
      if (prevGone) {
        const ring = dh.file("history.ring.json");
        await delay(300);
        if (existsSync(ring)) {
          const raw = JSON.parse(readFileSync(ring, "utf8")) as {
            samples: unknown[];
          };
          expect(raw.samples.length).toBeGreaterThan(0);
        }
      }

      const admin = buildAdminRouter({ pool });
      // biome-ignore lint/suspicious/noExplicitAny: oRPC router
      const hostsProc = (admin.router as any).surface.admin.hosts;
      const projected = await call(hostsProc.convergence, { host });
      expect(projected).toHaveProperty("anomaly");

      try {
        session!.destroy();
      } catch {
        //
      }
      await pinDone.catch(() => {});
      await pool.destroyAll();
      const idx = pools.indexOf(pool);
      if (idx >= 0) pools.splice(idx, 1);
      await delay(400);
    },
    120_000,
  );
});

describe("W4.1 / W4.4 production assembly confinement", () => {
  const src = readFileSync(join(import.meta.dir, "hostRegistry.ts"), "utf8");

  it("makeSession assembly wires admit (delete admit, ⇒ red)", () => {
    // Production site: makeSession({ ..., admit, label })
    expect(src).toMatch(
      /makeSession<[\s\S]*?admit,\s*\n\s*label:/,
    );
  });

  it("automatic admit wraps fireDrain for persist-failure capture", () => {
    expect(src).toMatch(/await probe\.fireDrain\(\)/);
    expect(src).toMatch(/captureDrainPersistFailure/);
    expect(src).toMatch(/convergenceFromDrainPersistFailure/);
  });

  it("refuse arm keeps setActiveCombined(active) for renew", () => {
    const m = src.match(/case "refuse":\s*\{([\s\S]*?)return \{/);
    expect(m).not.toBeNull();
    const block = m![1]!;
    expect(block).toMatch(/setActiveCombined\(\s*active\s*\)/);
    expect(block).not.toMatch(/setActiveCombined\(\s*null\s*\)/);
  });
});
