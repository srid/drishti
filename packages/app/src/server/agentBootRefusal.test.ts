/**
 * Agent-boot refusal classifier + barrier + yesterday-dir (legacy 0755) arm.
 *
 * Kolu follow-up (do NOT touch kolu from this PR): the upgrade-window testlib
 * should treat the state DIRECTORY itself (mode/ownership) as a shared
 * artifact — a mixed-version pre-existing 0755 home is a real upgrade hazard
 * nothing in the framework currently plants. Log for the framework; keep the
 * refusal test in the consumer until that lands.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ConnectError,
  type ClosedInfo,
  type Connection,
  type Connector,
  makeSession,
} from "@kolu/surface-remote";
import {
  AGENT_FATAL_PREFIXES,
  extractAgentBootFatal,
  isAgentBootRefusal,
} from "./agentBootRefusal";
import { withAgentBootBarrier } from "./withAgentBootBarrier";

const agentMain = join(import.meta.dir, "../../../agent/src/main.ts");

describe("extractAgentBootFatal", () => {
  it("captures ONLY the prefixed line payload (verbatim; stack is separate)", () => {
    // U2.4: message is the fatal line payload exactly — not stack/diagnostic tail.
    const msg =
      "daemonHome: /tmp/x is not a private owner-only directory (must be owned by the current user with mode 0700)";
    expect(
      extractAgentBootFatal([
        "noise",
        `drishti-agent: fatal: ${msg}`,
        "    at main",
        "Error: daemonHome: ...",
      ]),
    ).toBe(msg);
  });

  it("returns null when no fatal prefix is present (transport path)", () => {
    expect(
      extractAgentBootFatal(["host unreachable", "reconnecting in 2000ms…"]),
    ).toBeNull();
    expect(isAgentBootRefusal(["ssh: connect to host failed"])).toBe(false);
  });

  it("accepts every declared production prefix", () => {
    for (const p of AGENT_FATAL_PREFIXES) {
      expect(extractAgentBootFatal([`${p}boom`])).toBe("boom");
    }
  });

  it("U3.5: preserves meaningful leading whitespace in the payload (verbatim)", () => {
    // Exact post-prefix slice — do NOT trimStart a nonempty payload.
    expect(
      extractAgentBootFatal(["drishti-agent: fatal:   spaced cause"]),
    ).toBe("  spaced cause");
    expect(
      extractAgentBootFatal(["drishti-agent: fatal: \tleading tab"]),
    ).toBe("\tleading tab");
    // Empty / whitespace-only after prefix is still null (no message).
    expect(extractAgentBootFatal(["drishti-agent: fatal: "])).toBeNull();
    expect(extractAgentBootFatal(["drishti-agent: fatal:   "])).toBeNull();
  });
});

describe("withAgentBootBarrier", () => {
  it("fatal stderr + early exit ⇒ terminal ConnectError, onBootRefused, zero retries", async () => {
    const fatalMsg =
      "daemonHome: /tmp/legacy is not a private owner-only directory (must be owned by the current user with mode 0700)";
    let refused: string | null = null;
    let connectCalls = 0;

    const inner: Connector<{ ping: () => Promise<void> }> = async (ctx) => {
      connectCalls += 1;
      ctx.remoteProgress(`drishti-agent: fatal: ${fatalMsg}`);
      let settle!: (info: ClosedInfo) => void;
      const closed = new Promise<ClosedInfo>((r) => {
        settle = r;
      });
      // Die immediately — boot barrier must classify as terminal remote.
      queueMicrotask(() => settle({ kind: "exit", code: 1, signal: null }));
      const client = {
        ping: async () => {
          throw new Error("stream closed");
        },
      };
      return {
        client,
        closed,
        isAlive: async () => {
          throw new Error("stream closed");
        },
        teardown: () => {},
      } satisfies Connection<{ ping: () => Promise<void> }>;
    };

    const barrier = withAgentBootBarrier(inner, {
      onBootRefused: (m) => {
        refused = m;
      },
    });

    let err: unknown = null;
    try {
      await barrier({
        localProgress: () => {},
        remoteProgress: () => {},
        provisioning: () => {},
        connecting: () => {},
        signal: new AbortController().signal,
        campaignEpoch: 0,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConnectError);
    const ce = err as ConnectError;
    expect(ce.failureCause).toBe("remote");
    expect(ce.terminal).toBe(true);
    expect(ce.message).toContain("not a private owner-only directory");
    const refusedMsg = refused ?? "";
    expect(refusedMsg.length).toBeGreaterThan(0);
    expect(refusedMsg).toContain("not a private owner-only directory");
    expect(connectCalls).toBe(1);
  });

  it("transport-style death without fatal prefix is NOT terminal boot-refusal", async () => {
    const inner: Connector<{ ping: () => Promise<void> }> = async () => {
      let settle!: (info: ClosedInfo) => void;
      const closed = new Promise<ClosedInfo>((r) => {
        settle = r;
      });
      queueMicrotask(() =>
        settle({ kind: "transport-failed" }),
      );
      return {
        client: {
          ping: async () => {
            throw new Error("unreachable");
          },
        },
        closed,
        isAlive: async () => {
          throw new Error("unreachable");
        },
        teardown: () => {},
      };
    };

    const barrier = withAgentBootBarrier(inner);
    // No fatal line → barrier rewraps closed; does NOT throw terminal ConnectError.
    const conn = await barrier({
      localProgress: () => {},
      remoteProgress: () => {},
      provisioning: () => {},
      connecting: () => {},
      signal: new AbortController().signal,
      campaignEpoch: 0,
    });
    const info = await conn.closed;
    expect(info.kind).toBe("transport-failed");
  });

  it("session with terminal boot-refusal does not schedule endless reconnect", async () => {
    const fatalMsg =
      "daemonHome: /state is not a private owner-only directory (must be owned by the current user with mode 0700)";
    let connectCalls = 0;
    const progress: string[] = [];

    // biome-ignore lint/suspicious/noExplicitAny: test connector client is a stub
    const inner: Connector<any> = async (ctx) => {
      connectCalls += 1;
      ctx.remoteProgress(`drishti-agent: fatal: ${fatalMsg}`);
      let settle!: (info: ClosedInfo) => void;
      const closed = new Promise<ClosedInfo>((r) => {
        settle = r;
      });
      queueMicrotask(() => settle({ kind: "exit", code: 1, signal: null }));
      return {
        client: {
          surface: {
            system: {
              live: async () => {
                throw new Error("closed");
              },
            },
          },
        },
        closed,
        isAlive: async () => {
          throw new Error("closed");
        },
        teardown: () => {},
      };
    };

    // biome-ignore lint/suspicious/noExplicitAny: test session client is a stub
    const session = makeSession<any>({
      connectOnce: withAgentBootBarrier(inner),
      initialConnection: "connecting",
      reconnectDelayMs: 10,
      label: "boot-refuse-test",
    });
    // Capture diagnostic lines off the session log (no custom Logger shape).
    session.onState((s) => {
      for (const e of s.log) progress.push(e.line);
    });

    session.pin().catch(() => {});
    await delay(200);

    expect(session.currentState().phase).toBe("failed");
    // Terminal ConnectError: one connect attempt, no retry campaign.
    expect(connectCalls).toBe(1);
    expect(
      progress.some((l) => l.includes("host unreachable — retrying")),
    ).toBe(false);
    expect(progress.some((l) => /reconnecting in \d+ms/.test(l))).toBe(false);

    session.destroy();
  });
});

describe("yesterday-dir: planted legacy 0755 state dir (real agent)", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const d of temps.splice(0)) {
      try {
        chmodSync(d, 0o700);
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

  it.skipIf(typeof process.getuid !== "function")(
    "real agent against 0755 ~/.local/state/drishti ⇒ fatal carries daemonHome message",
    async () => {
      // Kolu follow-up (framework, not this PR): upgrade-window testlib should
      // treat the state DIRECTORY itself (mode/ownership) as a shared artifact —
      // plant/verify 0755→refuse and 0700→ok as mixed-version upgrade hazards.
      // Logged for kolu; do not edit the framework pin from drishti.
      const home = mkdtempSync(join(tmpdir(), "drishti-legacy-state-"));
      temps.push(home);
      const stateDir = join(home, ".local", "state", "drishti");
      mkdirSync(stateDir, { recursive: true, mode: 0o755 });
      chmodSync(stateDir, 0o755);
      // Prove the plant is the mixed-version artifact (not 0700).
      // biome-ignore lint/style/noNonNullAssertion: getuid exists under skipIf
      expect((process as NodeJS.Process).getuid!()).toBeDefined();

      const child = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
        env: {
          ...process.env,
          HOME: home,
          XDG_STATE_HOME: join(home, ".local", "state"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (c: string) => {
        stderr += c;
      });

      const code = await new Promise<number | null>((resolve) => {
        child.on("exit", (c) => resolve(c));
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            //
          }
          resolve(-1);
        }, 15_000);
      });

      expect(code).toBe(1);
      expect(stderr).toMatch(/drishti-agent: fatal:/);
      // Verbatim daemonHome refusal (the production incident message class).
      expect(stderr).toMatch(/not a private owner-only directory/);
      expect(stderr).toMatch(/mode 0700/);
      // The planted path should appear in the message.
      expect(stderr).toContain(stateDir);

      // Classifier sees the same block the parent barrier would.
      const lines = stderr.split("\n").filter((l) => l.length > 0);
      const extracted = extractAgentBootFatal(lines);
      expect(extracted).not.toBeNull();
      expect(extracted!).toMatch(/not a private owner-only directory/);
      expect(extracted!).toContain(stateDir);
    },
  );

  it("session boot-refused outcome projects for a planted 0755 home via barrier", async () => {
    // Composition test: real fatal text → barrier → typed outcome stash.
    if (typeof process.getuid !== "function") return;

    const home = mkdtempSync(join(tmpdir(), "drishti-legacy-pool-"));
    temps.push(home);
    const stateDir = join(home, ".local", "state", "drishti");
    mkdirSync(stateDir, { recursive: true, mode: 0o755 });
    chmodSync(stateDir, 0o755);

    // Capture what the real agent would write (spawn once, use stderr as remote lines).
    const child = nodeSpawn(process.execPath, [agentMain, "--stdio"], {
      env: {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: join(home, ".local", "state"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      setTimeout(() => resolve(), 10_000);
    });

    const remoteLines = stderr.split("\n").filter((l) => l.length > 0);
    const fatal = extractAgentBootFatal(remoteLines);
    expect(fatal).not.toBeNull();
    expect(fatal!).toMatch(/not a private owner-only directory/);

    let outcome: { kind: "boot-refused"; message: string } | null = null;
    let connectCalls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test connector client is a stub
    const inner: Connector<any> = async (ctx) => {
      connectCalls += 1;
      for (const line of remoteLines) ctx.remoteProgress(line);
      let settle!: (info: ClosedInfo) => void;
      const closed = new Promise<ClosedInfo>((r) => {
        settle = r;
      });
      queueMicrotask(() => settle({ kind: "exit", code: 1, signal: null }));
      return {
        client: {
          surface: {
            system: {
              live: async () => {
                throw new Error("closed");
              },
            },
          },
        },
        closed,
        isAlive: async () => {
          throw new Error("closed");
        },
        teardown: () => {},
      };
    };

    // biome-ignore lint/suspicious/noExplicitAny: test session client is a stub
    const session = makeSession<any>({
      connectOnce: withAgentBootBarrier(inner, {
        onBootRefused: (message) => {
          outcome = { kind: "boot-refused", message };
        },
      }),
      initialConnection: "connecting",
      reconnectDelayMs: 20,
      label: "legacy-0755",
    });
    session.pin().catch(() => {});
    await delay(300);
    expect(session.currentState().phase).toBe("failed");
    expect(connectCalls).toBe(1);
    expect(outcome).not.toBeNull();
    expect(outcome!.kind).toBe("boot-refused");
    expect(outcome!.message).toMatch(/not a private owner-only directory/);
    expect(outcome!.message).toContain(stateDir);
    session.destroy();
  });
});
