/**
 * The warm host SESSION pool — single source of truth for "which hosts
 * this parent server knows about" and their `DaemonSession` lifecycle
 * (spawn/reconnect/recheck/destroy + control-core admit/convergence).
 *
 * UW3: each host session is a `DaemonSession` over the combined
 * app+control agent contract. The parent dials via `sshConnector` against
 * the agent's durable `--stdio` front; `convergeAdmit` decides whether to
 * adopt, drain-and-replace, or refuse the resident daemon.
 *
 * Drishti-written plugs on the framework skeleton:
 *   - **policy** — `drishtiAgentConvergencePolicy` (contract version, drain
 *     arms, budget)
 *   - **link projection** — session `onState` → `DrishtiConvergence` /
 *     `link-failed`
 *   - **combined-client stash** — WeakMap from app-scoped client → combined
 *     dial so admit/renew can reach control-core
 *   - **exit oracle** — `awaitExitViaProcessOracle` (ClosedInfo.kind === "exit"
 *     only; transport loss never looks like process exit)
 *   - **renew** — drain + await exit via control-core for build-axis replace
 *
 * Decision table, budget arithmetic, and probe live in
 * `@kolu/surface-daemon-supervisor`. Host-set persistence is `hostsStore.ts`.
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
  type ConnectorDrainBudget,
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
import { AGENT_SURFACE_VERSION, surface } from "drishti-common";
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
/**
 * Framework anomalies AS-IS, plus session-owned link-failed and the parent's
 * typed drain outcome when the final history flush failed (W3.2).
 */
export type DrishtiConvergence =
  | ConvergenceAnomaly
  | { readonly kind: "link-failed"; readonly detail: string }
  | {
      readonly kind: "drained-with-persist-failure";
      readonly detail: string;
      readonly error: string;
    };

/** Wire result of control-core drain when the agent reports flush status. */
export type DrainVerbResult = {
  ok: boolean;
  persistFailed: boolean;
  error: string | null;
};

/**
 * Parent-side projection of a drain verb result (W3.2). Pure — unit-tested so
 * dropping `persistFailed` from the drain result / ignoring it goes red.
 */
export function convergenceFromDrainResult(
  result: DrainVerbResult | null | undefined,
): Extract<DrishtiConvergence, { kind: "drained-with-persist-failure" }> | null {
  if (result?.persistFailed) {
    return {
      kind: "drained-with-persist-failure",
      detail: "final history ring flush failed during drain",
      error: result.error ?? "persist-failed",
    };
  }
  return null;
}

/**
 * Parse drain verb throw / return into a typed result (W3.2). Mutations that
 * stop throwing DRISHTI_PERSIST_FAILED or strip persistFailed go red via the
 * parent unit + flushFail process tests.
 */
export function parseDrainVerbOutcome(args: {
  raw?: unknown;
  err?: unknown;
}): DrainVerbResult | null {
  if (args.raw !== undefined && args.raw !== null && typeof args.raw === "object") {
    if ("persistFailed" in args.raw) {
      const r = args.raw as {
        ok?: boolean;
        persistFailed?: boolean;
        error?: string | null;
      };
      return {
        ok: r.ok === true,
        persistFailed: r.persistFailed === true,
        error: typeof r.error === "string" ? r.error : null,
      };
    }
  }
  if (args.err !== undefined && args.err !== null) {
    const e = args.err as {
      code?: string;
      message?: string;
      data?: { persistFailed?: boolean; error?: string | null };
    };
    if (e.code === "DRISHTI_PERSIST_FAILED") {
      return {
        ok: false,
        persistFailed: true,
        error:
          (typeof e.data?.error === "string" && e.data.error) ||
          e.message ||
          "persist-failed",
      };
    }
    const msg = e.message ?? "";
    if (msg.includes("DRISHTI_PERSIST_FAILED")) {
      return {
        ok: false,
        persistFailed: true,
        error:
          msg.replace(/^.*DRISHTI_PERSIST_FAILED:?\s*/, "") || "persist-failed",
      };
    }
  }
  return null;
}

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

/** Result of resolving a host to an agent derivation — includes the
 *  probed nix system so multi-arch parents can pick the matching expected
 *  build id (UW3 convergeAdmit). */
export type ResolvedHostAgent = {
  derivation: AgentDerivation;
  /** Nix system string from the arch probe (e.g. `x86_64-linux`). */
  system: string;
};

export interface HostPoolOptions {
  initialHosts: readonly string[];
  /** Resolve a host string to its agent `.drv` + probed system. */
  resolveDrvPath: (
    host: string,
    context: ResolveDrvPathContext,
  ) => Promise<ResolvedHostAgent>;
  hostsFile: string;
  /**
   * Per-system expected agent BUILD_IDs. Required whenever the pool is
   * provisioning (the default — resolveDrvPath is always the provision path).
   * Only omit / leave empty with `offNix: true`.
   */
  buildIdBySystem?: Readonly<Record<string, string>>;
  /**
   * Genuine off-nix parent: no agent drv map at all. When true, expected
   * build id falls back to env / can't-judge. When false/omitted, the pool
   * is provisioning and buildIdBySystem must cover every system (W3.6).
   */
  offNix?: boolean;
}

/** Live combined dial stashed under the app-scoped client admit receives. */
type ActiveCombined = {
  client: AgentDaemonClient;
  dispose: () => void;
  processExit: Promise<void>;
  signal: AbortSignal;
};

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

/**
 * Process-exit oracle: resolve ONLY on ClosedInfo.kind === "exit".
 * transport-failed / endpoint-down / spawn-error are link or bootstrap
 * loss — never process exit; leave the wait hanging until the ceiling
 * yields drain-not-taken.
 *
 * Exported for unit tests that exercise the same wait semantics without
 * importing the full pool.
 */
export function awaitExitViaProcessOracle(
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

/**
 * Admit factory: probe identity, run convergeAdmit, bind active on adopt.
 * Exported for W3.1a mutation pins (bypass convergeAdmit ⇒ drain not called).
 */
export function makeAgentAdmit(args: {
  combinedByScopedClient: WeakMap<AgentAppClient, ActiveCombined>;
  /** Budget is minted on first drv resolve (when system is known). */
  getBudget: () => ReturnType<typeof createConnectorDrainBudget>;
  setConvergence: (c: DrishtiConvergence | null) => void;
  setActiveCombined: (a: ActiveCombined | null) => void;
}): Admit<AgentAppClient> {
  return async (scopedClient): Promise<AdmitVerdict> => {
    const active = args.combinedByScopedClient.get(scopedClient);
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
      budget: args.getBudget(),
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
        args.setConvergence(null);
        args.setActiveCombined(active);
        return { kind: "adopt" };
      }
      case "adopt-stale": {
        args.setConvergence(verdict.anomaly);
        args.setActiveCombined(active);
        return { kind: "adopt" };
      }
      case "replaced": {
        args.setConvergence(null);
        return { kind: "replaced", reason: verdict.reason };
      }
      case "refuse": {
        // W3.4: retain the combined binding so renew() can drain a refused
        // session (skew / cross-supervisor) instead of throwing on null.
        args.setConvergence(verdict.anomaly);
        args.setActiveCombined(active);
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
}

/**
 * Attach daemon supervision members (convergence / renew / preservation)
 * onto a base Session, plus the link-state projection that keeps
 * `DrishtiConvergence` honest at the edge.
 */
function attachDaemonSession(args: {
  base: Session<AgentAppClient, SshProv>;
  getConvergence: () => DrishtiConvergence | null;
  setConvergence: (c: DrishtiConvergence | null) => void;
  getActiveCombined: () => ActiveCombined | null;
  setActiveCombined: (a: ActiveCombined | null) => void;
}): HostSession {
  const { base } = args;

  // Link-state projection at the edge — the ONLY convergence code
  // drishti writes besides the policy object.
  base.onState((s) => {
    if (s.phase === "failed") {
      const current = args.getConvergence();
      // Standing refuse anomalies keep their binding for renew (W3.4).
      const standingRefuse =
        current?.kind === "skew-refused" ||
        current?.kind === "cross-supervisor" ||
        current?.kind === "unconverged";
      if (!standingRefuse) {
        args.setConvergence({
          kind: "link-failed",
          detail: s.error,
        });
        args.setActiveCombined(null);
      }
    } else if (s.phase === "disconnected") {
      const current = args.getConvergence();
      if (current === null || current.kind === "link-failed") {
        args.setConvergence(null);
      }
      const standingRefuse =
        current?.kind === "skew-refused" ||
        current?.kind === "cross-supervisor" ||
        current?.kind === "unconverged" ||
        current?.kind === "drained-with-persist-failure";
      if (!standingRefuse) {
        args.setActiveCombined(null);
      }
    }
  });

  return Object.assign(base, {
    convergence: () => args.getConvergence(),
    preservation: { children: "die" as const },
    // Minimal renew on drainAndAwaitExit; result projects persist failure (W3.2).
    renew: async () => {
      const active = args.getActiveCombined();
      if (active === null) {
        throw new Error(
          "drishti agent is not bound — cannot drain (the daemon is unreachable)",
        );
      }
      // Object holder: TS control-flow analysis ignores assignments inside the
      // drainAndAwaitExit callback if we use a bare `let`.
      const drainHolder: { result: DrainVerbResult | null } = { result: null };
      const { took, drainRejection } = await drainAndAwaitExit(
        async () => {
          try {
            const raw: unknown =
              await active.client.surface.control.core.drain();
            drainHolder.result = parseDrainVerbOutcome({ raw });
          } catch (err) {
            // Agent throws ORPCError code DRISHTI_PERSIST_FAILED (W3.2).
            const parsed = parseDrainVerbOutcome({ err });
            if (parsed !== null) {
              drainHolder.result = parsed;
              return; // drain fired; awaitExit still waits for process exit
            }
            throw err;
          }
        },
        (signal) => awaitExitViaProcessOracle(active.processExit, signal),
        { ceilingMs: DRAIN_TEARDOWN_CEILING_MS },
      );
      if (!took) {
        throw new Error(
          `drishti agent drain did not complete — it did not exit within ${DRAIN_TEARDOWN_CEILING_MS}ms` +
            drainRejectionSuffix(drainRejection),
        );
      }
      const projected = convergenceFromDrainResult(drainHolder.result);
      if (projected !== null) {
        args.setConvergence(projected);
      }
    },
  });
}

/** Build the warm host session pool. Sync: `makeSession` defers the spawn
 *  into the session's own reconnect machinery, so a host unreachable at
 *  boot surfaces as a per-host `failed` connection state — never a throw
 *  that takes the whole pool (and with it the parent's HTTP port, never
 *  bound until this returns) down. */
/** Shared never-settling promise for non-exit closes (one allocation). */
const NEVER_EXITS: Promise<void> = new Promise(() => {});

/**
 * W2.6: resolve the expected agent BUILD_ID for a host.
 *
 * - `provisioning: true` (parent holds a drv map) ⇒ build-ids map MUST be
 *   non-empty and MUST contain the probed system. No single-ID / "" fallback.
 * - `provisioning: false` (genuine off-nix, no drv map) ⇒ can't-judge via
 *   fallbackBuildId (may be "").
 */
export function expectProvisionedBuildId(args: {
  system: string | undefined;
  buildIdBySystem: Readonly<Record<string, string>>;
  fallbackBuildId: string;
  /** True when the parent holds a drv map and is provisioning agents. */
  provisioning: boolean;
}): string {
  if (args.provisioning) {
    const keys = Object.keys(args.buildIdBySystem);
    if (keys.length === 0) {
      throw new Error(
        "drishti agent provision: drv map is present but BUILD_IDS map is empty — cannot admit without per-system expected build ids",
      );
    }
    if (args.system === undefined) {
      throw new Error(
        "drishti agent provision: remote system unknown but BUILD_IDS map is present — cannot select expected build id",
      );
    }
    const bySystem = args.buildIdBySystem[args.system];
    if (bySystem === undefined || bySystem === "") {
      throw new Error(
        `drishti agent provision: missing BUILD_ID for system ${JSON.stringify(args.system)} — DRISHTI_AGENT_BUILD_IDS_JSON must cover every provisioned system (no silent "" fallback on the provisioned path)`,
      );
    }
    return bySystem;
  }
  return args.fallbackBuildId;
}

export function buildHostPool(opts: HostPoolOptions): HostPool {
  // Policy is pure config (mint once as fallback). Budget is minted PER host
  // entry so flaps on host A don't exhaust host B's drain attempts — and so
  // the expected build id can match the host's probed system (multi-arch).
  const fallbackBuildId = process.env.DRISHTI_AGENT_BUILD_ID ?? "";
  const buildIdBySystem = opts.buildIdBySystem ?? {};
  // W3.6: provisioning is decided by the DRV map path (resolveDrvPath is
  // always how this pool provisions). Only `offNix: true` opts out — never
  // the absence of the ids map (that inversion is the F6 defect).
  const provisioning = opts.offNix !== true;
  if (provisioning && Object.keys(buildIdBySystem).length === 0) {
    throw new Error(
      "buildHostPool: provisioning path requires a non-empty buildIdBySystem (drv map is in use via resolveDrvPath; pass offNix: true only for genuine off-nix parents)",
    );
  }

  return buildRemotePool<HostSession, undefined>({
    initialHosts: opts.initialHosts,
    buildEntry: (host) => {
      // Arm-local convergence state (closures, not class fields).
      let convergence: DrishtiConvergence | null = null;
      let activeCombined: ActiveCombined | null = null;
      const combinedByScopedClient = new WeakMap<
        AgentAppClient,
        ActiveCombined
      >();
      // Budget minted once per host, after the first drv resolve when we know
      // the remote system and can pick the matching expected build id.
      let budget: ReturnType<typeof createConnectorDrainBudget> | null = null;
      let expectedBuildId = fallbackBuildId;

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
        // drishti-server's ambient `process.env` (identity vars, secrets). Thread
        // identity + state placement env the agent needs under a clean base.
        localEnv: Object.fromEntries(
          (
            [
              "HOME",
              "PATH",
              "XDG_STATE_HOME",
              "DRISHTI_OSFACTS_BIN",
              "DRISHTI_AGENT_BUILD_ID",
            ] as const
          )
            .map((k): [string, string | undefined] => [k, process.env[k]])
            .filter((e): e is [string, string] => e[1] !== undefined),
        ),
        resolveDrvPath: async (context) => {
          const resolved = await opts.resolveDrvPath(host, context);
          // W2.6: provisioned path fail-fast via expectProvisionedBuildId.
          if (budget === null) {
            expectedBuildId = expectProvisionedBuildId({
              system: resolved.system,
              buildIdBySystem,
              fallbackBuildId,
              provisioning,
            });
            budget = createConnectorDrainBudget(
              drishtiAgentConvergencePolicy(expectedBuildId),
            );
          }
          return resolved.derivation;
        },
      });

      // Connector wraps the combined dial: stash ActiveCombined, hand admit
      // the app-scoped client (pump + kill forward use that scope).
      const rawConnector: Connector<AgentAppClient, SshProv> = async (ctx) => {
        const conn = await inner(ctx);
        // Process-exit oracle: settle only on ClosedInfo.kind === "exit".
        // Rejection and non-exit closes are link loss — never process exit
        // (shared NEVER_EXITS so we don't allocate a pending promise per dial).
        const processExit = conn.closed.then(
          (info: ClosedInfo) => {
            if (info.kind !== "exit") return NEVER_EXITS;
          },
          () => NEVER_EXITS,
        );
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

      const admit = makeAgentAdmit({
        combinedByScopedClient,
        getBudget: () => {
          if (budget === null) {
            // resolveDrvPath always runs before admit; mint with fallback if not.
            budget = createConnectorDrainBudget(
              drishtiAgentConvergencePolicy(expectedBuildId),
            );
          }
          return budget;
        },
        setConvergence: (c) => {
          convergence = c;
        },
        setActiveCombined: (a) => {
          activeCombined = a;
        },
      });

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

      const session = attachDaemonSession({
        base,
        getConvergence: () => convergence,
        setConvergence: (c) => {
          convergence = c;
        },
        getActiveCombined: () => activeCombined,
        setActiveCombined: (a) => {
          activeCombined = a;
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
