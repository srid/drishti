/**
 * U3.1: production assembly boot-refusal through REAL buildHostPool.
 *
 * - Standing set keeps boot-refused through failed transition (not link-failed).
 * - Real agent + real buildHostPool against planted 0755 state dir (both pool
 *   hooks live — no makeSession reenactment).
 * - Transport failure without fatal still retries.
 *
 * Kolu follow-up (do NOT touch kolu): upgrade-window testlib should treat the
 * state DIRECTORY itself (mode/ownership) as a shared artifact.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
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
  type ClosedInfo,
  type Connector,
  makeSession,
} from "@kolu/surface-remote";
import { buildAdminRouter } from "./admin-router";
import { chipFromDaemonStatus } from "../client/daemonStatusPresentation";
import { projectDaemonStatus } from "./daemonStatusProjection";
import {
  buildHostPool,
  type HostPool,
  type HostSession,
} from "./hostRegistry";
import { withAgentBootBarrier } from "./withAgentBootBarrier";

const daemonTestsEnabled = process.env.KOLU_DAEMON_TESTS === "1";

const hostRegistrySrc = readFileSync(
  join(import.meta.dir, "hostRegistry.ts"),
  "utf8",
);

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

    const drvsProc = Bun.spawn(["nix", "eval", "--raw", ".#agentDrvsJson"], {
      stdout: "pipe",
      stderr: "pipe",
    });
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

/**
 * ssh shim that execs the remaining command locally under e2e env, and
 * counts agent --stdio dials into DRISHTI_E2E_CONNECT_LOG (one line per dial).
 */
function writeSshShim(binDir: string): void {
  const shim = join(binDir, "ssh");
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
  # both-or-neither (readBakedIdentity / UW5) — never BUILD_ID alone
  export DRISHTI_AGENT_COMMIT_HASH="\${DRISHTI_E2E_COMMIT_HASH:-e2e-\$DRISHTI_E2E_BUILD_ID}"
fi
if [[ -n "\${DRISHTI_OSFACTS_BIN:-}" ]]; then
  export DRISHTI_OSFACTS_BIN
fi
# Count ONLY agent --stdio dials (not nix-copy / probe ssh). HOME is the
# planted e2e home so the log needs no extra env var.
for _arg in "\$@"; do
  if [[ "\$_arg" == "--stdio" ]]; then
    printf 'stdio\\n' >> "\$HOME/.drishti-e2e-connect.log"
    break
  fi
done
exec "\$@"
`,
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);
}

function connectAttempts(logPath: string): number {
  try {
    const raw = readFileSync(logPath, "utf8");
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

describe("U2.1 boot-refused stands through failed transition", () => {
  it("production standing set includes boot-refused (source pin)", () => {
    // Mutation: remove boot-refused from the failed-phase standing set ⇒ red.
    const failedBlock = hostRegistrySrc.match(
      /if \(s\.phase === "failed"\) \{([\s\S]*?)\} else if \(s\.phase === "disconnected"\)/,
    );
    expect(failedBlock).not.toBeNull();
    expect(failedBlock![1]).toMatch(
      /standingRefuse\s*=\s*[\s\S]*?boot-refused/,
    );
    expect(failedBlock![1]).toMatch(
      /current\?\.kind === "boot-refused"/,
    );
  });

  it("final projection/chip is boot-refused not link-failed after failed phase", () => {
    type Conv = ReturnType<HostSession["convergence"]>;
    let convergence: Conv = {
      kind: "boot-refused",
      detail: "daemonHome: refuse",
      message: "daemonHome: refuse",
    };
    const outcome: ReturnType<HostSession["outcome"]> = {
      kind: "boot-refused",
      message: "daemonHome: refuse",
    };
    const kind = convergence?.kind as string | undefined;
    const standing =
      kind === "skew-refused" ||
      kind === "cross-supervisor" ||
      kind === "unconverged" ||
      kind === "boot-refused";
    if (!standing) {
      convergence = { kind: "link-failed", detail: "agent exited" };
    }
    expect(convergence!.kind).toBe("boot-refused");
    const status = projectDaemonStatus({
      convergence: () => convergence,
      outcome: () => outcome,
      identity: () => null,
      currentState: () => ({ phase: "failed" }),
    });
    expect(status.anomaly?.kind).toBe("boot-refused");
    expect(chipFromDaemonStatus(status).kind).toBe("boot-refused");
    expect(chipFromDaemonStatus(status).kind).not.toBe("link-failed");
  });
});

describe("U3.1 production assembly — REAL buildHostPool planted 0755", () => {
  const temps: string[] = [];
  const pools: HostPool[] = [];
  afterEach(async () => {
    for (const p of pools.splice(0)) {
      try {
        await p.destroyAll();
      } catch {
        //
      }
    }
    for (const d of temps.splice(0)) {
      try {
        chmodSync(join(d, ".local", "state", "drishti"), 0o700);
      } catch {
        //
      }
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        //
      }
    }
  });

  it.skipIf(!daemonTestsEnabled)(
    "planted 0755 + real buildHostPool ⇒ boot-refused, one attempt, zero retries",
    async () => {
      // U3.1: REAL buildHostPool (both onBootRefused hooks live in production).
      // MUTATION: empty the pool hooks' outcome/convergence writes ⇒ this reds
      // (not a source regex).
      const fixture = await fixtureAgent();
      if (fixture === null) {
        throw new Error(
          "fixtureAgent required under KOLU_DAEMON_TESTS=1 — nix/store fixture required",
        );
      }

      const home = mkdtempSync(join(tmpdir(), "drishti-pool-boot-"));
      temps.push(home);
      const stateDir = join(home, ".local", "state", "drishti");
      mkdirSync(stateDir, { recursive: true, mode: 0o755 });
      chmodSync(stateDir, 0o755);

      const binDir = join(home, "bin");
      mkdirSync(binDir, { recursive: true });
      writeSshShim(binDir);

      // Connect-attempt log is written by the ssh shim under $HOME (see writeSshShim).
      const connectLog = join(home, ".drishti-e2e-connect.log");
      writeFileSync(connectLog, "");

      process.env.HOME = home;
      process.env.XDG_STATE_HOME = join(home, ".local", "state");
      process.env.DRISHTI_AGENT_BUILD_ID = fixture.buildId;
      process.env.DRISHTI_AGENT_COMMIT_HASH = `e2e-${fixture.buildId}`;
      process.env.DRISHTI_E2E_HOME = home;
      process.env.DRISHTI_E2E_XDG_STATE_HOME = join(home, ".local", "state");
      process.env.DRISHTI_E2E_BUILD_ID = fixture.buildId;
      process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

      // Non-local host name so the dial goes through sshConnector's ssh path
      // (localhost is a direct spawn — no ssh — and cannot count attempts via
      // the shim). The shim execs the agent locally under the e2e HOME.
      const host = "e2e-boot-refuse";
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

      const session = pool.getSession(host);
      expect(session).toBeDefined();

      // pin() drives the real pool dial (ssh → agent). Terminal boot refusal
      // rejects pin; outcome/convergence are set by production onBootRefused.
      try {
        await session!.pin();
      } catch {
        // expected: ConnectError terminal from withAgentBootBarrier
      }

      // Wait for terminal boot refusal (failed + boot-refused standing).
      const failDeadline = Date.now() + 60_000;
      while (Date.now() < failDeadline) {
        const phase = session!.currentState().phase;
        const out = session!.outcome();
        if (phase === "failed" && out?.kind === "boot-refused") break;
        await delay(100);
      }

      expect(session!.currentState().phase).toBe("failed");
      const out = session!.outcome();
      expect(out?.kind).toBe("boot-refused");
      if (out !== null && out.kind === "boot-refused") {
        expect(out.message).toMatch(/not a private owner-only directory/);
        expect(out.message).toContain(stateDir);
        expect(out.message).not.toMatch(/\n\s+at /);
      }
      expect(session!.convergence()?.kind).toBe("boot-refused");
      expect(session!.convergence()?.kind).not.toBe("link-failed");

      const projected = projectDaemonStatus(session!);
      expect(projected.anomaly?.kind).toBe("boot-refused");
      expect(chipFromDaemonStatus(projected).kind).toBe("boot-refused");

      // Admin router projects the same typed state through the real pool.
      const admin = buildAdminRouter({ pool });
      // biome-ignore lint/suspicious/noExplicitAny: oRPC router
      const hosts = (admin.router as any).surface.admin.hosts;
      const status = await call(hosts.daemonStatus, { host });
      expect(status.anomaly?.kind).toBe("boot-refused");
      if (status.anomaly?.kind === "boot-refused") {
        expect(status.anomaly.message).toMatch(
          /not a private owner-only directory/,
        );
        expect(status.anomaly.message).toContain(stateDir);
      }

      // Exactly one connector attempt; zero scheduled retries after settle.
      const attemptsAtSettle = connectAttempts(connectLog);
      expect(attemptsAtSettle).toBe(1);
      await delay(1_500);
      expect(connectAttempts(connectLog)).toBe(1);
      expect(session!.currentState().phase).toBe("failed");
    },
    120_000,
  );

  it("transport failure without fatal still retries (not terminal)", async () => {
    let connectCalls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: connector stub
    const flaky: Connector<any> = async () => {
      connectCalls += 1;
      let settle!: (info: ClosedInfo) => void;
      const closed = new Promise<ClosedInfo>((r) => {
        settle = r;
      });
      queueMicrotask(() => settle({ kind: "transport-failed" }));
      return {
        client: {
          surface: {
            system: {
              live: async () => {
                throw new Error("unreachable");
              },
            },
          },
        },
        closed,
        isAlive: async () => {
          throw new Error("unreachable");
        },
        teardown: () => {},
      };
    };

    // biome-ignore lint/suspicious/noExplicitAny: session stub
    const session = makeSession<any>({
      connectOnce: withAgentBootBarrier(flaky),
      initialConnection: "connecting",
      reconnectDelayMs: 20,
      label: "transport-retry",
    });
    session.pin().catch(() => {});
    await delay(400);
    expect(connectCalls).toBeGreaterThan(1);
    expect(session.currentState().phase).not.toBe("failed");
    session.destroy();
  });
});
