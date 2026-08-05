/**
 * The warm host SESSION pool — single source of truth for "which hosts
 * this parent server knows about" and their `DaemonSession` lifecycle
 * (spawn/reconnect/recheck/destroy + control-core admit/convergence).
 *
 * UW3: each host session is a `DaemonSession` over the agent's THREE-sibling
 * wire (`drishti-common/daemon`) — the versioned app surface, the frozen
 * control core, and drishti's own daemon sibling. One link, several faces:
 * `sshConnector` builds the app face from the surface value it is given, and
 * the other two are built over the same `Connection.dispatch`. The parent
 * dials against the agent's durable `--stdio` front; `convergeAdmit` decides
 * whether to adopt, drain-and-replace, or refuse the resident daemon.
 *
 * Drishti-written plugs on the framework skeleton:
 *   - **policy** — `drishtiAgentConvergencePolicy` (contract version, drain
 *     arms, budget)
 *   - **link projection** — session `onState` → `DrishtiConvergence` /
 *     `link-failed`
 *   - **sibling-face stash** — WeakMap from the app face `admit` receives to
 *     the control + drain faces over the same wire
 *   - **exit oracle** — `awaitExitViaProcessOracle` (ClosedInfo.kind === "exit"
 *     only; transport loss never looks like process exit)
 *   - **renew** — drain + await exit for build-axis replace, through drishti's
 *     OWN `daemon.ring.drain` so the persist verdict arrives as a value
 *
 * Decision table, budget arithmetic, and probe live in
 * `@kolu/surface-daemon-supervisor`. Host-set persistence is `hostsStore.ts`.
 */

import { Effect } from "effect";
import { buildSurfaceFace } from "@kolu/surface/client";
import type { SurfaceDispatch } from "@kolu/surface/link";
import {
  daemonBuild,
  stderrLogger,
  type Logger as DaemonLogger,
} from "@kolu/surface-daemon";
import {
  type ControlCoreProbeClient,
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
  ResolveDrvError,
  sshConnector,
  type SshProv,
} from "@kolu/surface-remote";
import { AGENT_SURFACE_VERSION } from "drishti-common";
import { drishtiAgentConvergencePolicy } from "drishti-common/convergence-policy";
import {
  agentControlSurface,
  agentDialSurface,
  agentDrainSurface,
  type DrainVerdict,
} from "drishti-common/daemon";
import { saveHosts } from "./hostsStore";
import { makeLogger } from "./log";
import { withAgentBootBarrier } from "./withAgentBootBarrier";

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


// The three surfaces the agent daemon serves — the versioned app surface, the
// frozen control core, and drishti's own daemon sibling — plus the composed
// wire both ends build from, now live in `drishti-common/daemon`, so the agent
// that SERVES them and the parent that DIALS them cannot drift.

/** App-sibling-scoped client — what the pump + kill forward use.
 *
 *  `AgentClient` is non-generic now (`= SurfaceFace`): there is no contract
 *  type to be generic over, and per-member precision lives in the spec-derived
 *  bound faces rather than in a second mapped type over the addressing layer.
 *  `sshConnector` builds this face from `agentDialSurface` directly, so the
 *  old `scopeSibling(client, "app")` re-wrap has nothing left to do — the
 *  connector's own client IS the app-scoped one. */
export type AgentAppClient = AgentClient;

/** The frozen control-core face, in the exact shape the supervisor's probe
 *  walks (`client.surface.control.core.{hello,drain}`). Built over the SAME
 *  link dispatch as the app face — one wire, several faces.
 *
 *  It IS the framework's own `ControlCoreProbeClient` — an alias, not a
 *  restatement. A hand-written twin would be a second copy of a shape that
 *  moves whenever the frozen fragment does (it just did: both verbs return
 *  Effects now), and the compiler would only catch the drift at the call. */
export type ControlProbeClient = ControlCoreProbeClient;

/** Build the control + drain faces a dialled connection needs beyond its app
 *  face. Both ride the link's own dispatch (`Connection.dispatch`), which the
 *  connector hands back precisely so a two-sibling daemon is ONE link with
 *  several faces instead of two dials. */
function daemonFacesOver(dispatch: SurfaceDispatch): {
  control: ControlProbeClient;
  drain: Effect.Effect<DrainVerdict, unknown>;
} {
  const core = (
    buildSurfaceFace(agentControlSurface, dispatch).surface as unknown as {
      core: ControlProbeClient["surface"]["control"]["core"];
    }
  ).core;
  const ring = (
    buildSurfaceFace(agentDrainSurface, dispatch).surface as unknown as {
      ring: { drain: () => Effect.Effect<DrainVerdict, unknown> };
    }
  ).ring;
  return {
    control: { surface: { control: { core } } },
    // An Effect VALUE, like the framework's own `DrainableProbe.fireDrain`:
    // building it dispatches nothing, so it is safely re-runnable and cannot
    // be `await`ed into a no-op.
    drain: Effect.suspend(() => ring.drain()),
  };
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
    }
  /** Terminal agent-boot refusal (daemonHome / fatal misconfig) — no retry. */
  | {
      readonly kind: "boot-refused";
      readonly detail: string;
      /** Verbatim agent fatal message (after prefix). */
      readonly message: string;
    };

/** A drain whose final durable-ring write did not land. Read off
 *  `daemon.ring.drain`'s DECLARED output — see `convergenceFromDrainVerdict`. */
export type DrainPersistFailure = {
  persistFailed: true;
  error: string;
};

/**
 * Project a captured drain persist-failure to the standing parent anomaly
 * (W4.2). Used by the automatic admit path and renew.
 */
export function convergenceFromDrainPersistFailure(
  failure: DrainPersistFailure | null | undefined,
): Extract<DrishtiConvergence, { kind: "drained-with-persist-failure" }> | null {
  if (failure?.persistFailed) {
    return {
      kind: "drained-with-persist-failure",
      detail: "final history ring flush failed during drain",
      error: failure.error,
    };
  }
  return null;
}

/**
 * Read a drain's persist verdict off `daemon.ring.drain`'s DECLARED output.
 *
 * This replaces `captureDrainPersistFailure`, which narrowed an
 * `ORPCError("DRISHTI_PERSIST_FAILED")` thrown out of the FROZEN control-core
 * drain. That channel declares no error, and in this protocol epoch a
 * rejecting `onDrain` is a defect — "a daemon whose drain hook throws is
 * broken, not busy". A full disk is not a broken daemon: the drain worked and
 * its final write did not land, which is a verdict about a SUCCESSFUL call.
 * So drishti asks its own verb and reads a value; there is no error to narrow,
 * no `err.code` to compare, and no cross-realm plain-object arm to keep.
 */
export function drainPersistFailureOf(
  verdict: DrainVerdict,
): DrainPersistFailure | null {
  if (verdict.persisted) return null;
  return {
    persistFailed: true,
    error: verdict.error ?? "persist-failed",
  };
}

/** The daemon session a host entry holds — supervision (convergence /
 *  renew / preservation) over the app-scoped agent client.
 *
 *  Parameterized like padi's `PadiSession`: `DaemonSession` itself is not
 *  generic over the provisioning phase, so we intersect the daemon members
 *  onto the `SshProv`-narrowed base `Session` for `onState`/`currentState`
 *  (otherwise `"probing"` / `"provisioning"` become unspellable). */
/**
 * Structured terminal outcome of the last dial/admit attempt (W8.1 / W8.2).
 * Projected by drishti on the HostSession so e2e can assert kinds/fields
 * without reading free-form Error.message strings from pin().
 */
export type HostSessionOutcome =
  | { readonly kind: "replaced"; readonly axis: "build" | "contract" }
  | {
      readonly kind: "refused";
      readonly anomalyKind: ConvergenceAnomaly["kind"];
    }
  | { readonly kind: "adopted" }
  | {
      readonly kind: "adopted-stale";
      readonly anomalyKind: ConvergenceAnomaly["kind"];
    }
  | {
      readonly kind: "resolve-failed";
      /** Discriminant of ResolveDrvError.resolution.kind */
      readonly resolutionKind: ResolveDrvError["resolution"]["kind"];
    }
  /** Terminal agent boot refusal — message is the fatal text after the prefix. */
  | { readonly kind: "boot-refused"; readonly message: string };

/** Frozen-fragment identity stashed at admit for the daemon dialog (UI phase). */
export type HostDaemonIdentity = {
  readonly stateRoot: string | null;
  readonly contractVersion: string | null;
  readonly startedAt: number | null;
  readonly commit: string | null;
  readonly buildId: string | null;
};

export type HostSession = Omit<
  DaemonSession<AgentAppClient, DrishtiConvergence>,
  "onState" | "currentState"
> &
  Pick<Session<AgentAppClient, SshProv>, "onState" | "currentState"> & {
    /** Last structured dial/admit outcome (W8.1 / W8.2). */
    outcome: () => HostSessionOutcome | null;
    /** Last control-core hello projection (null until first successful probe). */
    identity: () => HostDaemonIdentity | null;
  };

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

/**
 * W4.7: pool construction is a discriminated union — the illegal state
 * "provisioning without ids" / "off-nix with a resolver" is unspellable.
 *
 * - Provisioning: resolver + non-empty ids map both required.
 * - Off-nix: no `resolveDrvPath` field at all (no agent provision path).
 */
export type ProvisioningHostPoolOptions = {
  initialHosts: readonly string[];
  hostsFile: string;
  /** Resolve a host string to its agent `.drv` + probed system. */
  resolveDrvPath: (
    host: string,
    context: ResolveDrvPathContext,
  ) => Promise<ResolvedHostAgent>;
  /** Per-system expected agent BUILD_IDs — required, non-empty. */
  buildIdBySystem: Readonly<Record<string, string>>;
};

export type OffNixHostPoolOptions = {
  initialHosts: readonly string[];
  hostsFile: string;
  /** Discriminant: off-nix arm must not spell a resolver (W5.6). */
  resolveDrvPath?: never;
};

export type HostPoolOptions =
  | ProvisioningHostPoolOptions
  | OffNixHostPoolOptions;

function isProvisioningPool(
  opts: HostPoolOptions,
): opts is ProvisioningHostPoolOptions {
  return "resolveDrvPath" in opts;
}

/** Live combined dial stashed under the app-scoped client admit receives. */
type ActiveCombined = {
  /** The frozen control-core face — what the supervisor's probe walks. */
  client: ControlProbeClient;
  /** drishti's own drain, over the SAME link: flush, abort the lifetime, and
   *  ANSWER whether the final ring write landed. */
  drain: Effect.Effect<DrainVerdict, unknown>;
  dispose: () => void;
  processExit: Promise<void>;
  signal: AbortSignal;
};

/** drishti's convergence policy — drainable; drain-newer on contract skew;
 *  drain-and-replace on build mismatch; budgeted adopt-stale.
 *
 *  The DECLARATION moved to `drishti-common/convergence-policy` when the
 *  agent's `--stdio` front became a second supervisor of the same daemon
 *  (juspay/kolu#2101): a policy two supervisors must agree on cannot live
 *  inside one of them, and the agent's Nix closure cannot see `packages/app` at
 *  all. Re-exported here so no import path moved — what moved is the source of
 *  truth, not the API. */
export { DRAIN_MAX_ATTEMPTS } from "drishti-common/convergence-policy";
export { drishtiAgentConvergencePolicy };

/**
 * Process-exit oracle: succeed ONLY on ClosedInfo.kind === "exit".
 * transport-failed / endpoint-down / spawn-error are link or bootstrap
 * loss — never process exit; leave the wait hanging until the ceiling
 * yields drain-not-taken.
 *
 * It takes no `AbortSignal` any more. The signal had exactly one job — tell
 * this poll-shaped wait to stop once the framework's ceiling won — and the
 * framework now forks the oracle into a scope it closes on every path, so the
 * wait is INTERRUPTED instead of notified. Interruption is not refusable; an
 * abandoned AbortController was.
 *
 * Exported for unit tests that exercise the same wait semantics without
 * importing the full pool.
 */
export function awaitExitViaProcessOracle(
  processExit: Promise<void>,
): Effect.Effect<void> {
  return Effect.promise(() => processExit);
}

/**
 * W9: derive replaced-axis from structured contract versions already held at
 * admit time — never from verdict.reason prose.
 *
 * For a `replaced` verdict, convergeAdmit only drains when either the contract
 * axis or the build axis fired. Contracts differ ⇒ contract axis; equal
 * (compatible) contracts ⇒ build axis. Silent default-to-build is forbidden.
 */
function replacedAxisFromContracts(
  runningContractVersion: string,
  bakedContractVersion: string,
): "build" | "contract" {
  return runningContractVersion !== bakedContractVersion
    ? "contract"
    : "build";
}

/**
 * Admit factory: probe identity, run convergeAdmit, bind active on adopt.
 * Internal — bound by the production makeSession assembly (W4.1 dial e2e).
 */
function makeAgentAdmit(args: {
  combinedByScopedClient: WeakMap<AgentAppClient, ActiveCombined>;
  /** Budget is minted on first drv resolve (when system is known). */
  getBudget: () => ReturnType<typeof createConnectorDrainBudget>;
  getConvergence: () => DrishtiConvergence | null;
  setConvergence: (c: DrishtiConvergence | null) => void;
  setActiveCombined: (a: ActiveCombined | null) => void;
  setOutcome: (o: HostSessionOutcome) => void;
  setIdentity: (id: HostDaemonIdentity) => void;
}): Admit<AgentAppClient> {
  return async (scopedClient): Promise<AdmitVerdict> => {
    const active = args.combinedByScopedClient.get(scopedClient);
    if (active === undefined) {
      throw new Error("drishti agent admit: no matching combined connection");
    }
    // `Admit` is `(client) => Promise<AdmitVerdict>` — surface-remote's
    // session/reconnect machinery is the campaign's recorded Promise-shaped
    // residual, and it OWNS this seam. So the framework's Effects are run
    // here, at the boundary drishti does not own, rather than leaking a second
    // Promise face upward.
    const probe = await Effect.runPromise(
      probeDaemonIdentityFrom({
        client: active.client,
        dispose: active.dispose,
        capability: "drainable",
        awaitExit: awaitExitViaProcessOracle(active.processExit),
        drainCeilingMs: DRAIN_TEARDOWN_CEILING_MS,
      }),
    );
    if (active.signal.aborted) {
      throw new Error("drishti agent admit superseded");
    }
    // Stash frozen-fragment identity for the daemon dialog (typed projection).
    try {
      const hello = await Effect.runPromise(
        active.client.surface.control.core.hello(),
      );
      args.setIdentity({
        stateRoot: hello.stateRoot,
        contractVersion: hello.surfaceVersion,
        startedAt: hello.startedAt,
        commit: hello.commit ?? null,
        buildId: hello.buildId ?? null,
      });
    } catch {
      args.setIdentity({
        stateRoot: null,
        contractVersion: probe.identity.contractVersion,
        startedAt: null,
        commit: null,
        buildId:
          probe.identity.build.kind === "known"
            ? probe.identity.build.id
            : null,
      });
    }

    // W4.2: drain through drishti's OWN verb so the persist verdict comes back
    // as a value. It is a strict superset of the frozen `control.core.drain`
    // the supervisor's probe would otherwise fire — same latched flush, same
    // lifetime abort, plus the answer — so calling it INSTEAD is not a
    // divergence, it is the same drain with the one fact the frozen channel
    // cannot carry. We never present a failed final write as clean.
    const drainCapture: { failure: DrainPersistFailure | null } = {
      failure: null,
    };
    const drain = Effect.map(active.drain, (verdict) => {
      drainCapture.failure = drainPersistFailureOf(verdict);
    });

    const admitLog: DaemonLogger = stderrLogger();
    // Baked contract version for this budget — always AGENT_SURFACE_VERSION via
    // drishtiAgentConvergencePolicy (policyOf is package-private upstream).
    const bakedContractVersion = AGENT_SURFACE_VERSION;
    const verdict = await Effect.runPromise(
      convergeAdmit({
        running: {
          ...probe.identity,
          instanceKey: probe.instanceKey,
        },
        budget: args.getBudget(),
        drain,
        awaitExit: probe.awaitExit,
        ceilingMs: probe.drainCeilingMs,
        log: admitLog,
      }),
    );
    if (active.signal.aborted) {
      throw new Error("drishti agent admit superseded");
    }

    switch (verdict.kind) {
      case "adopt": {
        // W5.2: drained-with-persist-failure STANDS across successor adopt.
        const standing = args.getConvergence();
        if (standing?.kind !== "drained-with-persist-failure") {
          args.setConvergence(null);
        }
        args.setActiveCombined(active);
        args.setOutcome({ kind: "adopted" });
        return { kind: "adopt" };
      }
      case "adopt-stale": {
        args.setConvergence(verdict.anomaly);
        args.setActiveCombined(active);
        args.setOutcome({
          kind: "adopted-stale",
          anomalyKind: verdict.anomaly.kind,
        });
        return { kind: "adopt" };
      }
      case "replaced": {
        // Automatic path: project drained-with-persist-failure when the final
        // flush threw — never present a dirty drain as clean (W4.2).
        const projected = convergenceFromDrainPersistFailure(
          drainCapture.failure,
        );
        args.setConvergence(projected);
        // W8.2 / W9: structured replaced + axis from running vs baked contracts.
        args.setOutcome({
          kind: "replaced",
          axis: replacedAxisFromContracts(
            probe.identity.contractVersion,
            bakedContractVersion,
          ),
        });
        return { kind: "replaced", reason: verdict.reason };
      }
      case "refuse": {
        // W3.4 / W4.4: retain the combined binding so renew() can drain a
        // refused session instead of throwing on null.
        args.setConvergence(verdict.anomaly);
        args.setActiveCombined(active);
        args.setOutcome({
          kind: "refused",
          anomalyKind: verdict.anomaly.kind,
        });
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
  getOutcome: () => HostSessionOutcome | null;
  getIdentity: () => HostDaemonIdentity | null;
}): HostSession {
  const { base } = args;

  // Link-state projection at the edge — the ONLY convergence code
  // drishti writes besides the policy object.
  base.onState((s) => {
    if (s.phase === "failed") {
      const current = args.getConvergence();
      // Standing terminal/human-action anomalies keep their binding (W3.4 / U2.1).
      // boot-refused is terminal human-action state — never overwrite to link-failed.
      const standingRefuse =
        current?.kind === "skew-refused" ||
        current?.kind === "cross-supervisor" ||
        current?.kind === "unconverged" ||
        current?.kind === "boot-refused";
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
        current?.kind === "drained-with-persist-failure" ||
        current?.kind === "boot-refused";
      if (!standingRefuse) {
        args.setActiveCombined(null);
      }
    }
  });

  return Object.assign(base, {
    convergence: () => args.getConvergence(),
    outcome: () => args.getOutcome(),
    identity: () => args.getIdentity(),
    preservation: { children: "die" as const },
    // Minimal renew on drainAndAwaitExit; result projects persist failure (W3.2).
    renew: async () => {
      const active = args.getActiveCombined();
      if (active === null) {
        throw new Error(
          "drishti agent is not bound — cannot drain (the daemon is unreachable)",
        );
      }
      const drainHolder: { failure: DrainPersistFailure | null } = {
        failure: null,
      };
      const { took, drainRejection } = await Effect.runPromise(
        drainAndAwaitExit(
          Effect.map(active.drain, (verdict) => {
            drainHolder.failure = drainPersistFailureOf(verdict);
          }),
          awaitExitViaProcessOracle(active.processExit),
          { ceilingMs: DRAIN_TEARDOWN_CEILING_MS },
        ),
      );
      if (!took) {
        throw new Error(
          `drishti agent drain did not complete — it did not exit within ${DRAIN_TEARDOWN_CEILING_MS}ms` +
            drainRejectionSuffix(drainRejection),
        );
      }
      const projected = convergenceFromDrainPersistFailure(drainHolder.failure);
      if (projected !== null) {
        args.setConvergence(projected);
      } else {
        // W6.3: successful renew clears standing drained-with-persist-failure
        // (and any other anomaly that survived adopt). A failed flush above
        // re-projects; a clean drain acknowledges the prior dirty drain.
        args.setConvergence(null);
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
  // W4.7: discriminated union — provisioning is "has resolveDrvPath", never
  // an offNix boolean override.
  if (!isProvisioningPool(opts)) {
    // W5.6: off-nix pool with hosts constructs real sessions under the
    // can't-judge binder (empty build id). No resolveDrvPath.
    const fallbackBuildId = process.env.DRISHTI_AGENT_BUILD_ID ?? "";
    return buildRemotePool<HostSession, undefined>({
      initialHosts: opts.initialHosts,
      buildEntry: (host) => {
        let convergence: DrishtiConvergence | null = null;
        let activeCombined: ActiveCombined | null = null;
        let outcome: HostSessionOutcome | null = null;
        let identity: HostDaemonIdentity | null = null;
        const combinedByScopedClient = new WeakMap<
          AgentAppClient,
          ActiveCombined
        >();
        const expectedBuildId = fallbackBuildId;
        const budget = createConnectorDrainBudget(
          drishtiAgentConvergencePolicy(expectedBuildId),
        );
        const OFF_NIX_RESOLUTION = {
          kind: "unavailable" as const,
          failureCause: "remote" as const,
          terminal: false as const,
        };
        const OFF_NIX_MSG =
          "off-nix pool: no agent derivation (can't-judge path has no resolveDrvPath)";
        const inner = sshConnector({
          // Effect RPC cannot mint a client from a TYPE — it needs the flat
          // `RpcGroup` and the spec to re-nest the face from. `agentDialSurface`
          // carries the app sibling's spec/prefix (so this face IS the
          // app-scoped client) with the COMBINED group (so the one RPC client
          // behind it can also address the control and daemon siblings' tags,
          // whose faces we build over the same dispatch below).
          surface: agentDialSurface,
          host,
          binary: "drishti-agent",
          localEnv: Object.fromEntries(
            (
              [
                "HOME",
                "PATH",
                "XDG_STATE_HOME",
                "DRISHTI_OSFACTS_BIN",
                // both-or-neither (readBakedIdentity) — never BUILD_ID alone
                "DRISHTI_AGENT_BUILD_ID",
                "DRISHTI_AGENT_COMMIT_HASH",
              ] as const
            )
              .map((k): [string, string | undefined] => [k, process.env[k]])
              .filter((e): e is [string, string] => e[1] !== undefined),
          ),
          resolveDrvPath: async () => {
            // W8.1: project resolution KIND before the connector wraps the throw.
            outcome = {
              kind: "resolve-failed",
              resolutionKind: OFF_NIX_RESOLUTION.kind,
            };
            throw new ResolveDrvError(OFF_NIX_MSG, OFF_NIX_RESOLUTION);
          },
        });
        const rawConnector: Connector<AgentAppClient, SshProv> = async (ctx) => {
          const conn = await inner(ctx);
          if (conn.dispatch === undefined) {
            // Every ssh dial has one; its absence would be a framework bug, and
            // without it the control and daemon siblings are unreachable — a
            // state where admit could never probe identity. Crash loudly.
            conn.teardown();
            throw new Error(
              "drishti host dial returned no transport dispatch — the control-core " +
                "and daemon faces cannot be built over it (a @kolu/surface-remote bug).",
            );
          }
          const processExit = conn.closed.then(
            (info: ClosedInfo) => {
              if (info.kind !== "exit") return NEVER_EXITS;
            },
            () => NEVER_EXITS,
          );
          const faces = daemonFacesOver(conn.dispatch);
          const active: ActiveCombined = {
            client: faces.control,
            drain: faces.drain,
            dispose: conn.teardown,
            processExit,
            signal: ctx.signal,
          };
          // `conn.client` IS the app-scoped face (the connector built it from
          // `agentDialSurface`), so the WeakMap is keyed by the very value
          // `makeSession` hands `admit` — no re-wrap in between to re-key on.
          combinedByScopedClient.set(conn.client, active);
          return conn;
        };
        // Terminal agent-boot refusal (daemonHome non-0700 etc.): capture fatal
        // stderr, set typed outcome, throw ConnectError(terminal) — zero retries.
        const connectOnce = withAgentBootBarrier(rawConnector, {
          onBootRefused: (message) => {
            outcome = { kind: "boot-refused", message };
            convergence = {
              kind: "boot-refused",
              detail: message,
              message,
            };
          },
        });
        const admit = makeAgentAdmit({
          combinedByScopedClient,
          getBudget: () => budget,
          getConvergence: () => convergence,
          setConvergence: (c) => {
            convergence = c;
          },
          setActiveCombined: (a) => {
            activeCombined = a;
          },
          setOutcome: (o) => {
            outcome = o;
          },
          setIdentity: (id) => {
            identity = id;
          },
        });
        const base = makeSession<AgentAppClient, SshProv>({
          connectOnce,
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
          getOutcome: () => outcome,
          getIdentity: () => identity,
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

  // Policy is pure config (mint once as fallback). Budget is minted PER host
  // entry so flaps on host A don't exhaust host B's drain attempts — and so
  // the expected build id can match the host's probed system (multi-arch).
  const fallbackBuildId = process.env.DRISHTI_AGENT_BUILD_ID ?? "";
  const buildIdBySystem = opts.buildIdBySystem;
  if (Object.keys(buildIdBySystem).length === 0) {
    throw new Error(
      "buildHostPool: provisioning path requires a non-empty buildIdBySystem (drv map is in use via resolveDrvPath)",
    );
  }
  const provisioning = true;
  const resolveDrvPath = opts.resolveDrvPath;

  return buildRemotePool<HostSession, undefined>({
    initialHosts: opts.initialHosts,
    buildEntry: (host) => {
      // Arm-local convergence state (closures, not class fields).
      let convergence: DrishtiConvergence | null = null;
      let activeCombined: ActiveCombined | null = null;
      let outcome: HostSessionOutcome | null = null;
      let identity: HostDaemonIdentity | null = null;
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
      const inner = sshConnector({
        // The surface as a VALUE (see the off-nix arm above for why).
        surface: agentDialSurface,
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
              // both-or-neither (readBakedIdentity) — never BUILD_ID alone
              "DRISHTI_AGENT_BUILD_ID",
              "DRISHTI_AGENT_COMMIT_HASH",
            ] as const
          )
            .map((k): [string, string | undefined] => [k, process.env[k]])
            .filter((e): e is [string, string] => e[1] !== undefined),
        ),
        resolveDrvPath: async (context) => {
          const resolved = await resolveDrvPath(host, context);
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
        if (conn.dispatch === undefined) {
          conn.teardown();
          throw new Error(
            "drishti host dial returned no transport dispatch — the control-core " +
              "and daemon faces cannot be built over it (a @kolu/surface-remote bug).",
          );
        }
        const faces = daemonFacesOver(conn.dispatch);
        const active: ActiveCombined = {
          client: faces.control,
          drain: faces.drain,
          dispose: conn.teardown,
          processExit,
          signal: ctx.signal,
        };
        // `conn.client` IS the app-scoped face now — nothing to re-wrap, so
        // the WeakMap is keyed by the very value `admit` receives.
        combinedByScopedClient.set(conn.client, active);
        return conn;
      };

      // Terminal agent-boot refusal: fatal stderr ⇒ typed outcome, zero retries.
      const connectOnce = withAgentBootBarrier(rawConnector, {
        onBootRefused: (message) => {
          outcome = { kind: "boot-refused", message };
          convergence = {
            kind: "boot-refused",
            detail: message,
            message,
          };
        },
      });

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
        getConvergence: () => convergence,
        setConvergence: (c) => {
          convergence = c;
        },
        setActiveCombined: (a) => {
          activeCombined = a;
        },
        setOutcome: (o) => {
          outcome = o;
        },
        setIdentity: (id) => {
          identity = id;
        },
      });

      const base = makeSession<AgentAppClient, SshProv>({
        connectOnce,
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
        getOutcome: () => outcome,
        getIdentity: () => identity,
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
