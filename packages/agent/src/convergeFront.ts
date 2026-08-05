/**
 * The `drishti-agent --stdio` front's **converge-before-relay** pre-step
 * (juspay/kolu#2101).
 *
 * ## The parity hole this closes — drishti's fleet arm had the whole class
 *
 * kolu's incident was padi's, but drishti shipped the same shape and rather
 * more of it. `drishti-agent --stdio` handed `frontDaemonOverStdio` a socket
 * path and spliced into whatever accepted: no gate read, no identity probe, no
 * epoch check. Worse than kolu's remote arm, in fact — kolu at least ran the
 * full kit locally, whereas drishti's ONLY supervisor was the parent's
 * `convergeAdmit`, an ssh hop away from the gate file, the pid table and the
 * signals it would need to act.
 *
 * And drishti's daemon is **resident**: it idle-exits after 60 minutes, so it
 * routinely outlives a deploy. A previous-epoch drishti agent is not a rare
 * race, it is the ordinary state of every host between a deploy and the next
 * idle timeout. That is exactly the population the incident wedged.
 *
 * The fix is not to teach the generic relay about convergence —
 * `frontDaemonOverStdio` is contract-blind by contract, and that blindness is
 * what makes the byte splice legal. It is to run the convergence kit in the
 * owning binary, BEFORE the relay engages, on the box where the facts live.
 *
 * ## What the front converges with
 *
 * The full kit — nothing stubbed, because a stubbed probe is how the hole
 * reopens:
 *
 *   - **probe** = the `probeDaemonIdentity` FACTORY, not the `…From` variant
 *     the parent's admit hook uses. This is the load-bearing difference: the
 *     factory dials a throwaway raw socket with a BYTE TAP and a silence
 *     deadline, which is the only thing in the kit that can SEE a
 *     previous-epoch peer. `probeDaemonIdentityFrom` reuses an
 *     already-assembled client and has no unspeakable wiring at all — it is
 *     assembly-only, and drishti's exclusive use of it is precisely why its
 *     `unspeakable-protocol` status arm has been a dead-but-typed branch since
 *     it was written. This pre-step is its first producer.
 *   - **policy** = `drishtiAgentFrontConvergencePolicy`, beside the parent's in
 *     `drishti-common/convergence-policy`. Deliberately NOT the parent's own:
 *     the front answers the epoch question and defers every in-epoch verdict
 *     (contract skew, build mismatch) to `convergeAdmit`, which has the budget,
 *     the standing anomaly and the UI. See that module for the argument.
 *   - **OS facts** = `osfacts`, already baked into the drishti-agent wrapper
 *     for the pid gate, so gate corroboration and gate-less-squatter recovery
 *     work here with no new axis to bake.
 *   - **driver** = the front's own `reExecAsDetachedDaemon` thunk, so a
 *     takeover replaces the resident with a daemon of THIS closure.
 *   - **connect** = the frozen control core only (see below).
 *
 * ## Why the dial is the control core and not the app face
 *
 * This front never speaks drishti's app contract — it relays raw bytes. The
 * convergence kit reads identity from the frozen control core's `hello`, which
 * is the version-agnostic channel that exists for exactly this. Building the
 * app face here would demand a contract this file would immediately discard,
 * and would refuse daemons the relay could happily serve.
 *
 * ## The verdict is a banner, not an exception
 *
 * A converged front greets `ready` and relays. A front that could not converge
 * writes a `refused` banner carrying the typed anomaly and exits non-zero
 * WITHOUT relaying — so the parent learns "this host's agent speaks a previous
 * protocol epoch" as a fact it can render, instead of inferring a down host
 * from a ping timeout. There is no arm here that relays anyway.
 *
 * Double convergence with the parent's own `convergeAdmit` is deliberate and
 * harmless: after this front converges, the admit meets a daemon of its own
 * epoch and simply adopts. The admit stays the in-epoch authority for the
 * durable session (generation fencing, contract skew, the drain budget), which
 * this pre-step does not and should not replace.
 */

import {
  reExecAsDetachedDaemon,
  stderrLogger,
  type DaemonHomePaths,
} from "@kolu/surface-daemon";
import {
  type ControlCoreProbeClient,
  converge,
  createEndpoint,
  type DaemonConnection,
  type DaemonDriver,
  dialSocket,
  outcomeAnomaly,
  probeDaemonIdentity,
  readControlCoreHello,
} from "@kolu/surface-daemon-supervisor";
import { buildSurfaceFace } from "@kolu/surface/client";
import type { StdioReadinessVerdict } from "@kolu/surface/links/readiness";
import { socketDuplexLink } from "@kolu/surface/links/stdio";
import { Effect } from "effect";
import {
  agentControlSurface,
  agentDaemonComposed,
} from "drishti-common/daemon";
import { drishtiAgentFrontConvergencePolicy } from "drishti-common/convergence-policy";
import {
  bakedOsFactsBin,
  osfactsSocketHolders,
  processIdentityAsync,
} from "osfacts-client";

/** What the front reports as "identity" — the frozen control core's answer,
 *  which is all the convergence kit reads. The two axes are drishti's whole
 *  identity story: the baked build id, and the commit for navigation. */
interface FrontIdentity {
  readonly staleKey: string;
  readonly navigableCommit: string;
}

/**
 * Dial the frozen control core at `socketPath` and hand the kit a connection.
 *
 * The group is the COMBINED one (`agentDaemonComposed.group`) because the
 * daemon binds every sibling's tags on one wire and an RPC client must know
 * the tag it dispatches; the FACE is the control sibling's, because that is the
 * only one this file speaks. Same shape the testlib's `facesOver` uses — one
 * link, faces re-nested over the one dispatch.
 */
function connectControlCore(
  socketPath: string,
): Effect.Effect<
  DaemonConnection<ControlCoreProbeClient, FrontIdentity>,
  Error
> {
  return Effect.gen(function* () {
    const socket = yield* dialSocket(socketPath);
    // The socket is BOTH halves so its `close` stays observable to `onClose` —
    // the local-rendezvous residual `socketDuplexLink` documents. It takes no
    // readiness proof, and is owed none: this is a unix path on THIS box, and
    // its epoch safety is the very thing this converge is establishing.
    const link = yield* Effect.promise(() =>
      socketDuplexLink({
        group: agentDaemonComposed.group,
        socket,
        describe: `unix socket ${socketPath}`,
      }),
    );
    const core = (
      buildSurfaceFace(agentControlSurface, link.dispatch)
        .surface as unknown as ControlCoreProbeClient["surface"]["control"]
    ).core;
    const client: ControlCoreProbeClient = { surface: { control: { core } } };
    const dispose = async (): Promise<void> => {
      await link.dispose();
      socket.destroy();
    };
    // `onError`, not `catch`: an INTERRUPTED dial releases the link too, or the
    // protocol fibers leak on the abandonment path.
    const hello = yield* Effect.onError(readControlCoreHello(client), () =>
      Effect.promise(dispose),
    );
    let closed = false;
    socket.once("close", () => {
      closed = true;
    });
    return {
      client,
      identity: {
        staleKey: hello.buildId ?? "",
        navigableCommit: hello.commit ?? "",
      },
      startedAt: hello.startedAt,
      metadata: undefined,
      dispose: () => {
        void dispose().catch(() => {
          /* best-effort — a link already disposed is fine */
        });
      },
      onClose: (cb) => {
        if (closed) queueMicrotask(cb);
        else socket.once("close", cb);
      },
    };
  });
}

export interface ConvergeAgentFrontOptions {
  /** The home the front resolved — gate and socket co-located, never a loose
   *  path pair. The SAME home `frontDaemonOverStdio` will relay to. */
  readonly home: DaemonHomePaths;
  /** The detached daemon's stderr sink, so a takeover's replacement still
   *  leaves a readable trail instead of `/dev/null`. */
  readonly stderrLog: string;
  /** This front's OWN baked build id — the expectation, stated from the end
   *  that IS the closure ssh just provisioned. */
  readonly buildId: string;
}

/**
 * Converge the durable drishti agent this front is about to relay to, and
 * answer with the banner the front should write.
 *
 * `ready` means a daemon of THIS epoch and contract now holds the rendezvous —
 * adopted, drained-and-replaced, or taken over from a previous-epoch resident.
 * Anything else is `refused`, carrying the framework's typed
 * `ConvergenceAnomaly` verbatim as the banner's opaque payload; drishti's
 * `DrishtiConvergence` union is that same shape, so the parent decodes it with
 * no converter between.
 *
 * The endpoint's converge connection is DISPOSED before returning: it did its
 * job (proving identity), and leaving it open would hand the relay a socket the
 * front does not own. `frontDaemonOverStdio` then makes its own connection to
 * the daemon this step just settled — the adopt-or-spawn it already performs,
 * now guaranteed to meet a converged peer.
 */
export function convergeAgentStdioFront(
  opts: ConvergeAgentFrontOptions,
): Effect.Effect<StdioReadinessVerdict, Error> {
  return Effect.gen(function* () {
    // ONE axis — where this program's osfacts binary lives — resolved ONCE and
    // bound to BOTH OS-fact injects. A missing bake is a loud failure here
    // rather than a surprise mid-takeover.
    const osfactsBin = bakedOsFactsBin("DRISHTI_OSFACTS_BIN");
    // stderr, never stdout: stdout is the wire, and the banner must be the
    // first thing to land on it.
    const log = stderrLogger();
    const driver: DaemonDriver = {
      // The front's own spawn, lifted. `reExecAsDetachedDaemon` re-execs THIS
      // binary minus the front flags, so a takeover's replacement is an agent
      // of this closure serving this same home — the property the pre-step
      // rests on. The strip list matches `main.ts`'s, because a re-exec that
      // kept `--stdio` would spawn a second front instead of a daemon.
      spawn: Effect.try({
        try: () =>
          reExecAsDetachedDaemon({
            stripArgs: ["--stdio", "--broken-stdout-log"],
            stderrLog: opts.stderrLog,
          }),
        catch: (err) => err as Error,
      }),
    };

    const endpoint = createEndpoint<
      ControlCoreProbeClient,
      FrontIdentity,
      undefined
    >({
      hostId: "drishti-agent-stdio-front",
      home: opts.home,
      policy: drishtiAgentFrontConvergencePolicy(opts.buildId),
      // `not-drainable`, matching the policy: this front never asks a daemon to
      // drain. The probe keeps its byte tap and its silence deadline either way
      // — those are what see a previous-epoch peer, and they are the only
      // reason this pre-step exists.
      probe: probeDaemonIdentity({ capability: "not-drainable" }),
      readProcessIdentity: (pid) => processIdentityAsync(osfactsBin, pid),
      readSocketHolders: osfactsSocketHolders(osfactsBin),
      driver,
      connect: (path) => connectControlCore(path),
      log,
      // The front holds no reactive status — it converges once and then either
      // relays or exits, so every transition is already covered by the outcome
      // this function returns. Logging each to stderr keeps a takeover legible
      // in `agent.stderr.log` without inventing a second channel.
      onStatus: (_hostId, status) =>
        log.info({ state: status.state }, "drishti-agent --stdio: converge"),
    });

    const outcome = yield* converge(endpoint);
    const anomaly = outcomeAnomaly(outcome);
    // Release the converge connection whatever the verdict: the relay makes its
    // own, and leaving this one open would hand it a socket the front does not
    // own.
    endpoint.current()?.dispose();

    // ── Which refusals are the FRONT's to make ──────────────────────────────
    //
    // `skew-refused` is the framework saying: the resident answered `hello`,
    // here is its contract and its build, and your policy told me not to touch
    // it. Answering `hello` IS the epoch proof — a previous-epoch daemon cannot
    // produce one, which is the entire premise of the gate. So this is a peer
    // the banner may honestly certify, and the version disagreement belongs to
    // the parent's `convergeAdmit`, which has the budget, the standing anomaly
    // and the UI to act on it.
    //
    // Turning it into a `refused` banner instead would be a layering error with
    // teeth: the front would go terminal on a daemon the parent knows exactly
    // how to drain and replace, and drishti's whole skew → degraded → renew
    // path would become unreachable in production.
    const peerSpokeThisEpoch = anomaly?.kind === "skew-refused";
    if (outcome.kind === "refused" && !peerSpokeThisEpoch) {
      // Nothing of this epoch holds the rendezvous, and the front could not put
      // one there. `anomaly` is the framework's typed reason — including
      // `unconverged`'s `unspeakable-protocol` cause, the residual where the
      // gate stopped naming the classified pid between the observation and the
      // kill.
      const detail =
        anomaly?.detail ??
        `drishti agent at ${opts.home.socketPath} did not converge (${outcome.kind})`;
      log.error(
        { outcome: outcome.kind, socketPath: opts.home.socketPath, anomaly },
        "drishti-agent --stdio: refusing to relay — no daemon of this epoch holds the rendezvous",
      );
      return { verdict: "refused", detail, anomaly: anomaly ?? null };
    }

    log.info(
      {
        outcome: outcome.kind,
        socketPath: opts.home.socketPath,
        anomaly,
        deferredToParent: peerSpokeThisEpoch,
      },
      peerSpokeThisEpoch
        ? "drishti-agent --stdio: resident is in-epoch but version-skewed — relaying so the parent can adjudicate"
        : "drishti-agent --stdio: converged — relaying",
    );
    return { verdict: "ready" };
  });
}
