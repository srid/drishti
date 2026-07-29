/**
 * W3.6: buildHostPool derives provisioning from the DRV path (not the ids map).
 * Three arms: crash (no ids), crash (missing system), off-nix ok.
 * W3.2: parent drain-result → drained-with-persist-failure projection.
 * W3.1a: makeAgentAdmit wires convergeAdmit (bypass ⇒ no drain).
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import { daemonHome } from "@kolu/surface-daemon";
import { createConnectorDrainBudget } from "@kolu/surface-daemon-supervisor";
import { directAgentDerivation } from "@kolu/surface-remote";
import { TEST_BINARY_CACHE } from "@kolu/surface-remote/agentDerivation.testutil";
import {
  type AgentAppClient,
  type AgentDaemonClient,
  buildHostPool,
  convergenceFromDrainResult,
  drishtiAgentConvergencePolicy,
  expectProvisionedBuildId,
  makeAgentAdmit,
  parseDrainVerbOutcome,
  scopeAgentApp,
} from "./hostRegistry";

const agentMain = join(import.meta.dir, "../../../agent/src/main.ts");

const fakeResolve = async () => ({
  derivation: directAgentDerivation(
    "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-drishti-agent.drv",
    TEST_BINARY_CACHE,
  ),
  system: "x86_64-linux",
});

describe("buildHostPool provisioning from DRV map (W3.6)", () => {
  it("construction crashes when provisioning without buildIdBySystem", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-w36-"));
    try {
      expect(() =>
        buildHostPool({
          initialHosts: [],
          resolveDrvPath: fakeResolve,
          hostsFile: join(dir, "hosts.json"),
          // no buildIdBySystem, offNix omitted ⇒ provisioning
        }),
      ).toThrow(/non-empty buildIdBySystem/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("construction crashes when buildIdBySystem lacks the provisioned system at resolve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-w36b-"));
    try {
      // Pool constructs, but resolve-time expectProvisionedBuildId throws.
      const pool = buildHostPool({
        initialHosts: [],
        resolveDrvPath: fakeResolve,
        hostsFile: join(dir, "hosts.json"),
        buildIdBySystem: { "aarch64-linux": "only-arm" },
      });
      // Exercise the same helper the pool calls:
      expect(() =>
        expectProvisionedBuildId({
          system: "x86_64-linux",
          buildIdBySystem: { "aarch64-linux": "only-arm" },
          fallbackBuildId: "",
          provisioning: true,
        }),
      ).toThrow(/missing BUILD_ID for system/);
      await pool.destroyAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("off-nix pool constructs with empty buildIdBySystem", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-w36c-"));
    try {
      const pool = buildHostPool({
        initialHosts: [],
        resolveDrvPath: fakeResolve,
        hostsFile: join(dir, "hosts.json"),
        buildIdBySystem: {},
        offNix: true,
      });
      expect(pool.hosts()).toEqual([]);
      await pool.destroyAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("makeAgentAdmit production wiring (W3.1a)", () => {
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

  it("build mismatch via makeAgentAdmit drains previous (bypass admit ⇒ red)", async () => {
    const home = mkdtempSync(join(tmpdir(), "admit-w31a-"));
    temps.push(home);
    mkdirSync(join(home, ".local", "state"), { recursive: true, mode: 0o700 });
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    const dh = daemonHome({ app: "drishti", placement: "state" });

    const previousBuildId = "prev-admit-w31a";
    const currentBuildId = "curr-admit-w31a";
    const env = {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      DRISHTI_AGENT_BUILD_ID: previousBuildId,
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
    const prevPid = Number.parseInt(readFileSync(dh.gatePath, "utf8"), 10);

    // Dial the daemon socket (stdio front is only the relay; control-core
    // hello/drain live on the unix socket). Wait for hello so admit probe
    // does not race a half-ready router.
    const sock = await unixSocketLink({ socketPath: dh.socketPath });
    const client = sock.client as unknown as AgentDaemonClient;
    const helloDeadline = Date.now() + 10_000;
    let helloOk = false;
    while (Date.now() < helloDeadline) {
      try {
        await (
          client as {
            surface: { control: { core: { hello: () => Promise<unknown> } } };
          }
        ).surface.control.core.hello();
        helloOk = true;
        break;
      } catch {
        await delay(50);
      }
    }
    expect(helloOk).toBe(true);

    const scoped = scopeAgentApp(client);
    const map = new WeakMap<
      AgentAppClient,
      {
        client: AgentDaemonClient;
        dispose: () => void;
        processExit: Promise<void>;
        signal: AbortSignal;
      }
    >();
    const ac = new AbortController();
    let processExitResolve!: () => void;
    const processExit = new Promise<void>((r) => {
      processExitResolve = r;
    });
    const watch = setInterval(() => {
      try {
        process.kill(prevPid, 0);
      } catch {
        clearInterval(watch);
        processExitResolve();
      }
    }, 50);
    map.set(scoped, {
      client,
      dispose: () => {
        sock.dispose();
        try {
          front.kill("SIGTERM");
        } catch {
          //
        }
      },
      processExit,
      signal: ac.signal,
    });

    const admit = makeAgentAdmit({
      combinedByScopedClient: map,
      getBudget: () =>
        createConnectorDrainBudget(
          drishtiAgentConvergencePolicy(currentBuildId),
        ),
      setConvergence: () => {},
      setActiveCombined: () => {},
    });

    const verdict = await admit(scoped);
    clearInterval(watch);

    // Production: drain-and-replace → replaced. Mutation force-adopt never
    // drains → prev still alive.
    expect(verdict.kind).toBe("replaced");
    let prevGone = false;
    try {
      process.kill(prevPid, 0);
    } catch {
      prevGone = true;
    }
    expect(prevGone).toBe(true);
  }, 60_000);
});

describe("parent drain persist-failure projection (W3.2)", () => {
  it("parseDrainVerbOutcome maps ORPCError DRISHTI_PERSIST_FAILED", () => {
    const r = parseDrainVerbOutcome({
      err: {
        code: "DRISHTI_PERSIST_FAILED",
        message: "EACCES write",
        data: { persistFailed: true, error: "EACCES write" },
      },
    });
    expect(r).toEqual({
      ok: false,
      persistFailed: true,
      error: "EACCES write",
    });
  });

  it("parseDrainVerbOutcome maps raw drain return with persistFailed", () => {
    const r = parseDrainVerbOutcome({
      raw: { ok: false, persistFailed: true, error: "disk full" },
    });
    expect(r).toEqual({
      ok: false,
      persistFailed: true,
      error: "disk full",
    });
  });

  it("convergenceFromDrainResult projects drained-with-persist-failure", () => {
    const c = convergenceFromDrainResult({
      ok: false,
      persistFailed: true,
      error: "EACCES",
    });
    expect(c).toEqual({
      kind: "drained-with-persist-failure",
      detail: "final history ring flush failed during drain",
      error: "EACCES",
    });
  });

  it("dropping persistFailed from the drain result ⇒ no parent projection (mutation pin)", () => {
    // Simulates "drop the failure from the drain result" — raw without
    // persistFailed / parse ignoring it → null projection.
    const dropped = parseDrainVerbOutcome({
      raw: { ok: true }, // no persistFailed field
    });
    expect(dropped).toBeNull();
    expect(convergenceFromDrainResult(dropped)).toBeNull();
    expect(
      convergenceFromDrainResult({
        ok: true,
        persistFailed: false,
        error: null,
      }),
    ).toBeNull();
  });
});
