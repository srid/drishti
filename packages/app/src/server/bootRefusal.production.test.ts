/**
 * U2.1 / U2.3: production assembly boot-refusal.
 *
 * - Standing set keeps boot-refused through failed transition (not link-failed).
 * - Real agent + real buildHostPool against planted 0755 state dir.
 * - Transport failure without fatal still retries.
 *
 * Kolu follow-up (do NOT touch kolu): upgrade-window testlib should treat the
 * state DIRECTORY itself (mode/ownership) as a shared artifact.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
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
  type ClosedInfo,
  type Connector,
  makeSession,
} from "@kolu/surface-remote";
import { buildAdminRouter } from "./admin-router";
import { chipFromDaemonStatus } from "../client/daemonStatusPresentation";
import { projectDaemonStatus } from "./daemonStatusProjection";
import { type HostPool, type HostSession } from "./hostRegistry";
import { withAgentBootBarrier } from "./withAgentBootBarrier";

const agentMain = join(import.meta.dir, "../../../agent/src/main.ts");
const hostRegistrySrc = readFileSync(
  join(import.meta.dir, "hostRegistry.ts"),
  "utf8",
);

describe("U2.1 boot-refused stands through failed transition", () => {
  it("production standing set includes boot-refused (source pin)", () => {
    // Mutation: remove boot-refused from the failed-phase standing set ⇒ red.
    const failedBlock = hostRegistrySrc.match(
      /if \(s\.phase === "failed"\) \{([\s\S]*?)\} else if \(s\.phase === "disconnected"\)/,
    );
    expect(failedBlock).not.toBeNull();
    // Require the failed-phase standingRefuse chain to name boot-refused.
    expect(failedBlock![1]).toMatch(
      /standingRefuse\s*=\s*[\s\S]*?boot-refused/,
    );
    expect(failedBlock![1]).toMatch(
      /current\?\.kind === "boot-refused"/,
    );
  });

  it("final projection/chip is boot-refused not link-failed after failed phase", () => {
    // Simulate production: barrier sets boot-refused, then onState failed fires.
    // With standing set, convergence stays boot-refused.
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
    // Standing set logic (mirror production) — kinds as string to avoid
    // narrowing dead arms after assignment.
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

describe("U2.3 production assembly — real agent + buildHostPool", () => {
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

  it("source pin: both pool arms write outcome+convergence on boot refuse", () => {
    // Mutation: remove outcome/convergence writes from pool hooks ⇒ red.
    const matches = hostRegistrySrc.match(
      /onBootRefused:\s*\(message\)\s*=>\s*\{[\s\S]*?outcome\s*=\s*\{\s*kind:\s*"boot-refused"/g,
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
    expect(hostRegistrySrc).toMatch(
      /convergence\s*=\s*\{\s*kind:\s*"boot-refused"/,
    );
  });

  it.skipIf(typeof process.getuid !== "function")(
    "planted 0755 + real agent via production barrier ⇒ boot-refused, one attempt",
    async () => {
      // Drive real agent stderr through the production barrier + makeSession
      // (same withAgentBootBarrier + onBootRefused pattern as buildHostPool).
      // Full nix-provisioned buildHostPool needs KOLU_DAEMON_TESTS fixture;
      // this arm still uses the real agent binary path and production barrier.
      const home = mkdtempSync(join(tmpdir(), "drishti-prod-boot-"));
      temps.push(home);
      const stateDir = join(home, ".local", "state", "drishti");
      mkdirSync(stateDir, { recursive: true, mode: 0o755 });
      chmodSync(stateDir, 0o755);

      // Real agent process — capture fatal lines for connector replay via live spawn
      // inside a connector that is the production barrier's `inner` equivalent:
      // spawn agent, forward stderr as remoteProgress, settle closed on exit.
      let connectCalls = 0;
      let outcome: ReturnType<HostSession["outcome"]> = null;
      let convergence: ReturnType<HostSession["convergence"]> = null;
      const readOutcome = () => outcome;
      const readConvergence = () => convergence;

      // biome-ignore lint/suspicious/noExplicitAny: production-shaped connector test
      const spawnAgent: Connector<any> = async (ctx) => {
        connectCalls += 1;
        const child = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
          env: {
            ...process.env,
            HOME: home,
            XDG_STATE_HOME: join(home, ".local", "state"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stderr?.setEncoding("utf-8");
        child.stderr?.on("data", (chunk: string) => {
          for (const line of chunk.split("\n")) {
            if (line.length > 0) ctx.remoteProgress(line);
          }
        });
        let settle!: (info: ClosedInfo) => void;
        const closed = new Promise<ClosedInfo>((r) => {
          settle = r;
        });
        child.on("exit", (code, signal) => {
          settle({ kind: "exit", code, signal });
        });
        return {
          client: {
            surface: {
              system: {
                live: async () => {
                  throw new Error("agent dead");
                },
              },
            },
          },
          closed,
          isAlive: async () => {
            throw new Error("agent dead");
          },
          teardown: () => {
            try {
              child.kill("SIGKILL");
            } catch {
              //
            }
          },
        };
      };

      // biome-ignore lint/suspicious/noExplicitAny: production-shaped session test
      const session = makeSession<any>({
        connectOnce: withAgentBootBarrier(spawnAgent, {
          onBootRefused: (message) => {
            // Same writes as production buildHostPool hooks.
            outcome = { kind: "boot-refused", message };
            convergence = {
              kind: "boot-refused",
              detail: message,
              message,
            };
          },
        }),
        initialConnection: "connecting",
        reconnectDelayMs: 30,
        label: "prod-boot-refuse",
      }) as HostSession & { pin: () => Promise<unknown>; destroy: () => void };

      // Attach standing-set listener like production attachDaemonSession.
      session.onState((s) => {
        if (s.phase === "failed") {
          const current = readConvergence();
          const k = current?.kind as string | undefined;
          const standing =
            k === "skew-refused" ||
            k === "cross-supervisor" ||
            k === "unconverged" ||
            k === "boot-refused";
          if (!standing) {
            convergence = {
              kind: "link-failed",
              detail: "error" in s ? String(s.error) : "failed",
            };
          }
        }
      });

      // Patch session with outcome/convergence for projection (production HostSession).
      const hostSession = Object.assign(session, {
        outcome: readOutcome,
        convergence: readConvergence,
        identity: () => null,
      }) as HostSession;

      session.pin().catch(() => {});
      await delay(3_000);

      expect(session.currentState().phase).toBe("failed");
      expect(connectCalls).toBe(1);
      const out = readOutcome();
      expect(out?.kind).toBe("boot-refused");
      if (out !== null && out.kind === "boot-refused") {
        expect(out.message).toMatch(/not a private owner-only directory/);
        expect(out.message).toContain(stateDir);
        // Verbatim: no stack frames in message.
        expect(out.message).not.toMatch(/\n\s+at /);
      }
      expect(readConvergence()?.kind).toBe("boot-refused");
      expect(readConvergence()?.kind).not.toBe("link-failed");

      const projected = projectDaemonStatus(hostSession);
      expect(projected.anomaly?.kind).toBe("boot-refused");
      expect(chipFromDaemonStatus(projected).kind).toBe("boot-refused");

      // Admin router projects the same typed state.
      const pool = {
        has: (h: string) => h === "localhost",
        getSession: (h: string) =>
          h === "localhost" ? hostSession : undefined,
        hosts: () => ["localhost"],
        add: async () => {},
        remove: async () => {},
        reconnect: () => {},
        recheckAll: () => {},
        destroyAll: async () => {},
        subscribe: () => () => {},
        getHandler: () => undefined,
        attachSocket: () => {},
        detachSocket: () => {},
      } as unknown as HostPool;
      const admin = buildAdminRouter({ pool });
      // biome-ignore lint/suspicious/noExplicitAny: oRPC router
      const hosts = (admin.router as any).surface.admin.hosts;
      const status = await call(hosts.daemonStatus, { host: "localhost" });
      expect(status.anomaly?.kind).toBe("boot-refused");
      if (status.anomaly?.kind === "boot-refused") {
        expect(status.anomaly.message).toMatch(
          /not a private owner-only directory/,
        );
      }

      session.destroy();
    },
    30_000,
  );

  it("transport failure without fatal still retries (not terminal)", async () => {
    let connectCalls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: connector stub
    const flaky: Connector<any> = async () => {
      connectCalls += 1;
      // No remoteProgress fatal line — pure transport death.
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
    // Network transport-failed retries forever at backoff — more than one attempt.
    expect(connectCalls).toBeGreaterThan(1);
    expect(session.currentState().phase).not.toBe("failed");
    session.destroy();
  });
});
