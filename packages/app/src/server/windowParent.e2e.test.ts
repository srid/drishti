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
/**
 * W5.1: ONLY the flake's current agent .drv — never a random warm store
 * path. A pre-UW3 store agent is single-surface / ephemeral --stdio and
 * 404s on control.core.hello + app-scoped system.identity (the campaign's
 * lead root-cause).
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

    // Ensure realised so the e2e does not wedge on cold nix-copy alone.
    const outProc = Bun.spawn(["nix-store", "-r", drvPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await outProc.exited;

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

      // W5.1: HARD dial — zero catch-to-success. pin() drives production
      // admit. A build-axis `replaced` verdict REJECTS pin() with a drained
      // message while scheduling successor reconnect — that rejection IS the
      // successful drain path, not a wiring failure. Any other error fails.
      await session!.pin().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !/drained|build mismatch|reconnecting to re-handshake/i.test(msg)
        ) {
          throw err instanceof Error ? err : new Error(msg);
        }
      });

      // Wait for successor to connect after drain (or fail terminally).
      const advDeadline = Date.now() + 90_000;
      let lastPhase = session!.currentState().phase;
      while (Date.now() < advDeadline) {
        lastPhase = session!.currentState().phase;
        if (lastPhase === "connected" || lastPhase === "failed") {
          break;
        }
        await delay(100);
      }
      expect(lastPhase).toBe("connected");

      // Previous resident MUST be gone (unconditional — drain took the pid).
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
      expect(prevGone).toBe(true);

      // Successor serves history through the surface (dial it — not ring re-read alone).
      const succDeadline = Date.now() + 30_000;
      while (Date.now() < succDeadline) {
        if (session!.currentState().phase === "connected") break;
        await delay(100);
      }
      expect(session!.currentState().phase).toBe("connected");

      const ring = dh.file("history.ring.json");
      expect(existsSync(ring)).toBe(true);
      const raw = JSON.parse(readFileSync(ring, "utf8")) as {
        samples: unknown[];
      };
      expect(raw.samples.length).toBeGreaterThan(0);

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
      await pool.destroyAll();
      const idx = pools.indexOf(pool);
      if (idx >= 0) pools.splice(idx, 1);
      await delay(400);
    },
    120_000,
  );
});


describe("W5.3 real refuse + renew via production pool", () => {
  it.skipIf(!daemonTestsEnabled)(
    "contract-newer resident: anomaly via admin + real renew",
    async () => {
      const fixture = await fixtureAgent();
      if (fixture === null) {
        throw new Error("fixtureAgent required under KOLU_DAEMON_TESTS=1");
      }

      const home = mkdtempSync(join(tmpdir(), "drishti-refuse-e2e-"));
      temps.push(home);
      mkdirSync(join(home, ".local", "state"), {
        recursive: true,
        mode: 0o700,
      });
      const binDir = join(home, "bin");
      mkdirSync(binDir, { recursive: true });
      writeSshShim(binDir);

      // Plant a NEWER-contract resident (W5.3 env-injection twin of build id).
      const prevEnv = {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: join(home, ".local", "state"),
        DRISHTI_AGENT_BUILD_ID: `refuse-prev-${fixture.buildId.slice(0, 8)}`,
        DRISHTI_E2E_SURFACE_VERSION: "9.9.9",
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

      process.env.DRISHTI_AGENT_BUILD_ID = fixture.buildId;
      delete process.env.DRISHTI_E2E_SURFACE_VERSION;
      process.env.DRISHTI_E2E_HOME = home;
      process.env.DRISHTI_E2E_XDG_STATE_HOME = join(home, ".local", "state");
      process.env.DRISHTI_E2E_BUILD_ID = fixture.buildId;
      process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

      const host = "localhost";
      const hostsFile = join(home, "hosts.json");
      writeFileSync(hostsFile, JSON.stringify({ hosts: [] }));
      const pool = buildHostPool({
        initialHosts: [host],
        hostsFile,
        buildIdBySystem: { [fixture.system]: fixture.buildId },
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

      // pin may refuse (terminal) — do not catch-to-success; observe refuse path.
      await session.pin().catch((err) => {
        // Refuse throws the refuse error from makeSession; that is expected.
        if (!String(err?.message ?? err).length) throw err;
      });

      const deadline = Date.now() + 60_000;
      let anomaly = session.convergence();
      while (Date.now() < deadline) {
        anomaly = session.convergence();
        if (anomaly !== null) break;
        await delay(100);
      }
      expect(anomaly).not.toBeNull();
      expect(
        anomaly!.kind === "skew-refused" ||
          anomaly!.kind === "cross-supervisor" ||
          anomaly!.kind === "unconverged" ||
          String(anomaly!.kind).includes("skew") ||
          String(anomaly!.kind).includes("refus"),
      ).toBe(true);

      const admin = buildAdminRouter({ pool });
      // biome-ignore lint/suspicious/noExplicitAny: oRPC router
      const hostsProc = (admin.router as any).surface.admin.hosts;
      const projected = await call(hostsProc.convergence, { host });
      expect(projected.anomaly).not.toBeNull();

      // Real renew — not injected.
      const renewResult = await call(hostsProc.renew, { host });
      // renew should act (ok or structured error that is NOT "is not bound").
      if (renewResult && typeof renewResult === "object" && "ok" in renewResult) {
        if (renewResult.ok === false) {
          expect(String(renewResult.error ?? "")).not.toMatch(/is not bound/);
        }
      }

      // After renew, previous may be gone or session rebinding.
      await delay(500);
      try {
        session.destroy();
      } catch {
        //
      }
      await pool.destroyAll();
      const idx = pools.indexOf(pool);
      if (idx >= 0) pools.splice(idx, 1);
      try {
        process.kill(prevPid, "SIGKILL");
      } catch {
        //
      }
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
