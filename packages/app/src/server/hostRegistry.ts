/**
 * The warm host SESSION pool — single source of truth for "which hosts
 * this parent server knows about" and their `DaemonSession` lifecycle
 * (spawn/reconnect/recheck/destroy + control-core admit/convergence).
 *
 * UW3: each host session is a `DaemonSession` over the combined
 * app+control agent contract. The parent dials via `sshConnector` against
 * the agent's durable `--stdio` front; `convergeAdmit` decides whether to
 * adopt, drain-and-replace, or refuse the resident daemon. ONLY the policy
 * object and the link-state projection at the edge are drishti-written —
 * the decision table, budget, and probe live in
 * `@kolu/surface-daemon-supervisor`.
 *
 * What's left of the pre-map era is exactly `@kolu/surface-remote`'s
 * `buildRemotePool` plus the ONE piece of app-specific knowledge it
 * deliberately doesn't hold: how a host becomes a `DaemonSession`
 * (`makeSession`/`sshConnector` + admit), and where the host set persists
 * (`hostsStore.ts`).
 */

import { composeSurfaceContracts, scopeSibling } from "@kolu/surface/define";
import {
  controlCoreSurface,
  daemonBuild,
  stderrLogger,
  type Logger as DaemonLogger,
} from "@kolu/surface-daemon";
import {
  type ConvergenceAnomaly,
  convergeAdmit,
  createConnectorDrainBudget,
  drainAndAwaitExit,
  drainRejectionSuffix,
  probeDaemonIdentityFrom,
} from "@kolu/surface-daemon-supervisor";
import {
  type Admit,
  type AdmitVerdict,
  type AgentClient,
  type AgentDerivation,
  buildRemotePool,
  type ClosedInfo,
  type Connector,
  type DaemonSession,
  makeSession,
  type PoolControls,
  type ResolveDrvPathContext,
  type RemotePool,
  type Session,
  sshConnector,
  type SshProv,
} from "@kolu/surface-remote";
import { surface } from "drishti-common";
import { saveHosts } from "./hostsStore";
import { makeLogger } from "./log";

// Registry lifecycle events (host added/removed) get their own tag, like
// every other subsystem — so they can be filtered out of the combined
// stderr stream without the caller threading a logger in.
const log = makeLogger("registry");

// The parent's connect-handshake watchdog budget, passed explicitly to
// every session. Must stay well under the browser socket's own deadline
// (`wire.ts` `connectionTimeout: 60_000`) so the parent gives up on a
// wedged connect and cycles the ssh child *before* the browser drops the
// user. kolu defaults `connectTimeoutMs` to this same value; we state it
// at the call site so the budget is visible here, beside the constraint
// it answers to, rather than buried in the library's default.
const CONNECT_TIMEOUT_MS = 30_000;

/** How long a build/contract-mismatch drain waits for the ssh-bridged
 *  agent process to exit before treating the drain as not-taken. Sized
 *  above a local 2s because each liveness edge is a full ssh round-trip. */
const DRAIN_TEARDOWN_CEILING_MS = 6_000;

/** Agent surface contract version — must match the agent's control-core
 *  hello `surfaceVersion` (`"1.0"`). */
const AGENT_SURFACE_VERSION = "1.0";

/** Drain budget: at most 2 drain attempts per lineage, then adopt the
 *  resident with a standing anomaly rather than go dark. */
const DRAIN_MAX_ATTEMPTS = 2;

/** The two surfaces the agent daemon serves: the versioned app surface and
 *  the frozen control core. One keyed map for `composeSurfaceContracts` /
 *  `sshConnector` / the agent's `implementSurfaces`. */
export const agentDaemonSurfaces = {
  app: surface,
  control: controlCoreSurface,
} as const;

/** Combined wire contract — `{ surface: { app, control } }`. */
export const agentDaemonContract = composeSurfaceContracts(agentDaemonSurfaces);
export type AgentDaemonContract = typeof agentDaemonContract;

/** Combined client (app + control.core). */
export type AgentDaemonClient = AgentClient<AgentDaemonContract>;

/** App-sibling-scoped client — what the pump + kill forward use. */
export type AgentAppClient = AgentClient<typeof surface.contract>;

/** Narrow a dialed COMBINED client to its `.surface.app` sibling. */
export function scopeAgentApp(client: AgentDaemonClient): AgentAppClient {
  return scopeSibling(client, "app") as unknown as AgentAppClient;
}

/**
 * drishti's convergence descriptor — the framework anomaly union AS-IS,
 * plus session-owned `link-failed` at the edge. Framework anomalies ride
 * the wire without conversion; only the link projection is app-written.
 */
export type DrishtiConvergence =
  | ConvergenceAnomaly
  | { readonly kind: "link-failed"; readonly detail: string };

/** The daemon session a host entry holds — supervision (convergence /
 *  renew / preservation) over the app-scoped agent client.
 *
 *  Parameterized like padi's `PadiSession`: `DaemonSession` itself is not
 *  generic over the provisioning phase, so we intersect the daemon members
 *  onto the `SshProv`-narrowed base `Session` for `onState`/`currentState`
 *  (otherwise `"probing"` / `"provisioning"` become unspellable). */
export type HostSession = Omit<
  DaemonSession<AgentAppClient, DrishtiConvergence>,
  "onState" | "currentState"
> &
  Pick<Session<AgentAppClient, SshProv>, "onState" | "currentState">;

/** The pool `serveHostMap` consumes directly. */
export type HostPool = RemotePool<HostSession, undefined> & PoolControls;

export interface HostPoolOptions {
  initialHosts: readonly string[];
  /** Resolve a host string to its agent `.drv` path. The pool has no
   *  business knowing how the answer was reached (arch probe, map
   *  lookup, a static value for localhost-only dev) — it just awaits
   *  the resolved path per host. */
  resolveDrvPath: (
    host: string,
    context: ResolveDrvPathContext,
  ) => Promise<AgentDerivation>;
  hostsFile: string;
}

/** drishti's connector-arm convergence policy — drainable; drain-newer on
 *  contract skew; drain-and-replace on build mismatch; budgeted adopt-stale. */
export function drishtiAgentConvergencePolicy(binderBuildId: string) {
  return {
    capability: "drainable" as const,
    baked: {
      contractVersion: AGENT_SURFACE_VERSION,
      build: daemonBuild(binderBuildId),
    },
    onContractSkew: { kind: "drain-newer-else-refuse" as const },
    onBuildMismatch: { kind: "drain-and-replace" as const },
    drainBudget: {
      maxAttempts: DRAIN_MAX_ATTEMPTS,
      onGiveUp: "adopt-stale" as const,
    },
  };
}

/** Process-exit oracle: resolve ONLY on ClosedInfo.kind === "exit".
 *  transport-failed / endpoint-down / spawn-error are link or bootstrap
 *  loss — never process exit; leave the wait hanging until the ceiling
 *  yields drain-not-taken. */
function awaitExitViaProcessOracle(
  processExit: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
    };
    void processExit.then(() => {
      cleanup();
      resolve();
    });
  });
}

/** Build the warm host session pool. Sync: `makeSession` defers the spawn
 *  into the session's own reconnect machinery, so a host unreachable at
 *  boot surfaces as a per-host `failed` connection state — never a throw
 *  that takes the whole pool (and with it the parent's HTTP port, never
 *  bound until this returns) down. */
export function buildHostPool(opts: HostPoolOptions): HostPool {
  // ONE policy + budget for the whole pool. Budget memory is per-supervisor-
  // boot and SURVIVES adopts across dials (mint once, share across hosts'
  // admit hooks — each host has its own lineage key via instanceKey).
  // Per-host budgets would also work; one shared budget is fine because
  // lineage keys are instance-scoped (startedAt), not host-scoped collisions.
  const binderBuildId = process.env.DRISHTI_AGENT_BUILD_ID ?? "";
  const policy = drishtiAgentConvergencePolicy(binderBuildId);
  // Budget minted once; createConnectorDrainBudget is per-policy. For
  // multi-host we mint a budget PER host entry so one host's flap doesn't
  // exhaust another's budget — see buildEntry below.

  return buildRemotePool<HostSession, undefined>({
    initialHosts: opts.initialHosts,
    buildEntry: (host) => {
      // Per-host budget so flaps on host A don't spend host B's attempts.
      const budget = createConnectorDrainBudget(policy);

      // Arm-local convergence state (closures, not class fields).
      let convergence: DrishtiConvergence | null = null;

      type ActiveCombined = {
        client: AgentDaemonClient;
        dispose: () => void;
        processExit: Promise<void>;
        signal: AbortSignal;
      };
      const combinedByScopedClient = new WeakMap<
        AgentAppClient,
        ActiveCombined
      >();
      let activeCombined: ActiveCombined | null = null;

      // sshConnector always runs `<binary> --stdio` (appended by the connector
      // itself — do NOT pass `--stdio` in extraArgs). That flag is the durable
      // front: adopt-or-spawn the gate-held daemon and relay bytes.
      const inner = sshConnector<AgentDaemonContract>({
        host,
        binary: "drishti-agent",
        // surface-remote is policy-free: the CONSUMER composes the localhost arm's
        // spawn env (kolu#1884 / #1872). drishti dials "localhost" for real (every
        // host, including localhost, dials through this connector — see below), so a
        // localhost drishti-agent must run with EXACTLY this composed env, never
        // drishti-server's ambient `process.env` (identity vars, secrets). drishti
        // can't import kolu-pty's `composeSpawnEnv`, so it picks a clean base inline,
        // omitting any UNSET key (an empty HOME/PATH would misdirect lookups). Unused
        // on a real ssh host, where the local ssh client legitimately inherits.
        localEnv: Object.fromEntries(
          (["HOME", "PATH"] as const)
            .map((k): [string, string | undefined] => [k, process.env[k]])
            .filter((e): e is [string, string] => e[1] !== undefined),
        ),
        resolveDrvPath: (context) => opts.resolveDrvPath(host, context),
      });

      // Process-exit oracle: resolve ONLY on ClosedInfo `exit`.
      const rawConnector: Connector<AgentAppClient, SshProv> = async (ctx) => {
        const conn = await inner(ctx);
        const processExit = conn.closed.then((info: ClosedInfo) => {
          if (info.kind !== "exit") {
            // Keep the oracle unsettled so awaitExit only resolves on ceiling abort.
            return new Promise<void>(() => {});
          }
        });
        const active: ActiveCombined = {
          client: conn.client,
          dispose: conn.teardown,
          processExit,
          signal: ctx.signal,
        };
        const scopedClient = scopeAgentApp(conn.client);
        combinedByScopedClient.set(scopedClient, active);
        return { ...conn, client: scopedClient };
      };

      const admit: Admit<AgentAppClient> = async (
        scopedClient,
      ): Promise<AdmitVerdict> => {
        const active = combinedByScopedClient.get(scopedClient);
        if (active === undefined) {
          throw new Error("drishti agent admit: no matching combined connection");
        }
        const probe = await probeDaemonIdentityFrom({
          client: active.client,
          dispose: active.dispose,
          capability: "drainable",
          awaitExit: (signal) =>
            awaitExitViaProcessOracle(active.processExit, signal),
          drainCeilingMs: DRAIN_TEARDOWN_CEILING_MS,
        });
        if (active.signal.aborted) {
          throw new Error("drishti agent admit superseded");
        }

        const admitLog: DaemonLogger = stderrLogger();
        const verdict = await convergeAdmit({
          running: {
            ...probe.identity,
            instanceKey: probe.instanceKey,
          },
          budget,
          drain: probe.fireDrain,
          awaitExit: probe.awaitExit,
          ceilingMs: probe.drainCeilingMs,
          log: admitLog,
        });
        if (active.signal.aborted) {
          throw new Error("drishti agent admit superseded");
        }

        switch (verdict.kind) {
          case "adopt": {
            convergence = null;
            activeCombined = active;
            return { kind: "adopt" };
          }
          case "adopt-stale": {
            convergence = verdict.anomaly;
            activeCombined = active;
            return { kind: "adopt" };
          }
          case "replaced": {
            convergence = null;
            return { kind: "replaced", reason: verdict.reason };
          }
          case "refuse": {
            convergence = verdict.anomaly;
            return {
              kind: "refuse",
              state: { error: verdict.error, cause: "remote" },
            };
          }
          default: {
            const _exhaustive: never = verdict;
            throw new Error(
              `drishti agent admit: unreachable verdict ${JSON.stringify(_exhaustive)}`,
            );
          }
        }
      };

      const base = makeSession<AgentAppClient, SshProv>({
        connectOnce: rawConnector,
        // `sshConnector` PROVISIONS (nix-copies the agent closure before
        // dialing), so its true opening phase is the connector's FIRST
        // provisioning phase, "probing" (the remote connector advances
        // `probing → provisioning`) — every drishti host, including
        // "localhost", dials through it (kolu#1716/#1808).
        initialConnection: "probing",
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        admit,
        label: `host:${host}`,
      });

      // Link-state projection at the edge — the ONLY convergence code
      // drishti writes besides the policy object.
      base.onState((s) => {
        if (s.phase === "failed") {
          convergence = {
            kind: "link-failed",
            detail: s.error,
          };
          activeCombined = null;
        } else if (s.phase === "disconnected") {
          if (convergence === null || convergence.kind === "link-failed") {
            convergence = null;
          }
          activeCombined = null;
        }
      });

      const session: HostSession = Object.assign(base, {
        convergence: () => convergence,
        preservation: { children: "die" as const },
        renew: async () => {
          const active = activeCombined;
          if (active === null) {
            throw new Error(
              "drishti agent is not bound — cannot drain (the daemon is unreachable)",
            );
          }
          const { took, drainRejection } = await drainAndAwaitExit(
            () => active.client.surface.control.core.drain(),
            (signal) =>
              awaitExitViaProcessOracle(active.processExit, signal),
            { ceilingMs: DRAIN_TEARDOWN_CEILING_MS },
          );
          if (!took) {
            throw new Error(
              `drishti agent drain did not complete — it did not exit within ${DRAIN_TEARDOWN_CEILING_MS}ms` +
                drainRejectionSuffix(drainRejection),
            );
          }
        },
      });

      return { session, handler: undefined };
    },
    controls: {
      reconnect: (s) => s.reconnect(),
      recheck: (s) => s.recheck(),
    },
    persist: (hosts) => saveHosts(opts.hostsFile, hosts),
    log: (line) => log(line),
  });
}
