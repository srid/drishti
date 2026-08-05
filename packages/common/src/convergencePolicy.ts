/**
 * drishti's CONVERGENCE POLICY — who the drishti agent daemon is, and what a
 * supervisor of it should do when the resident daemon is not that.
 *
 * ## Why it lives in `drishti-common` and not in the supervisor that consumes it
 *
 * It used to live in `packages/app/src/server/hostRegistry.ts`, for the only
 * reason that mattered at the time: the parent's connector arm was the ONLY
 * supervisor of a drishti agent. juspay/kolu#2101 ends that — `drishti-agent
 * --stdio` now converges the durable daemon it is about to relay to, ON the
 * remote box, before it splices a byte. So there are two supervisors, and they
 * must not disagree about the agent's contract version, its drain semantics, or
 * how many build drains one instance may spend.
 *
 * The home follows the volatility, not the caller: every field here is a fact
 * about the **drishti agent** (its {@link AGENT_SURFACE_VERSION}, that it is
 * drainable, that a contract skew means "drain a newer one else refuse", that a
 * build mismatch means "drain and replace"). None is a fact about the parent
 * server, which merely happened to ask first. `packages/common` is also the one
 * place BOTH projections can see it: the agent's Nix closure is a positive
 * projection of `packages/agent` + `packages/common` only — `packages/app` is
 * not an input — so a policy left app-side is structurally invisible to the
 * front that now needs it.
 *
 * This is a separate export subpath (`drishti-common/convergence-policy`) and
 * deliberately not part of `drishti-common`'s root export: the root is what the
 * browser bundle pulls, and nothing about supervising a unix-socket daemon
 * belongs in a tab.
 */

import {
  type ConvergencePolicy,
  daemonBuild,
} from "@kolu/surface-daemon-supervisor";
import { AGENT_SURFACE_VERSION } from "./surface";

/**
 * How many BUILD-axis drains one supervisor instance may spend on one agent
 * lineage before it gives up and rides the resident with a standing anomaly.
 *
 * Shared by both arms (the parent's ssh connector and the agent's own `--stdio`
 * front), because a budget two supervisors disagree about is not a budget: the
 * front would keep replacing a daemon the parent had already decided to adopt.
 */
export const DRAIN_MAX_ATTEMPTS = 2;

/**
 * The PARENT connector arm's policy — `convergeAdmit`'s, over the ssh link.
 * Drainable: the agent daemon serves the frozen control core's `drain`, and
 * drishti's own `daemon.ring.drain` sibling rides the same latched flush.
 * `onGiveUp: "adopt-stale"` so a flapping lineage rides the resident with a
 * standing anomaly rather than going dark.
 *
 * `binderBuildId` is the build id the parent expects that host's agent closure
 * to carry.
 *
 * NOTE — no explicit `: ConvergencePolicy<…>` return type, and it must not grow
 * one. `ConnectorPolicy`, which `createConnectorDrainBudget` demands, is
 * NARROWER on `onContractSkew` (it admits no `recycle` arm). Annotating the
 * return widens these literals to the full union and the connector arm stops
 * typechecking. `as const satisfies` already proves conformance — it checks the
 * shape without erasing which arm was chosen, which is the property the
 * consumer needs.
 */
export function drishtiAgentConvergencePolicy(binderBuildId: string) {
  return {
    capability: "drainable",
    baked: {
      contractVersion: AGENT_SURFACE_VERSION,
      build: daemonBuild(binderBuildId),
    },
    onContractSkew: { kind: "drain-newer-else-refuse" },
    onBuildMismatch: { kind: "drain-and-replace" },
    drainBudget: {
      maxAttempts: DRAIN_MAX_ATTEMPTS,
      onGiveUp: "adopt-stale",
    },
  } as const satisfies ConvergencePolicy<"drainable">;
}

/**
 * The `--stdio` FRONT's policy — deliberately not the one above.
 *
 * ## The two supervisors answer different questions
 *
 * The front's question is the EPOCH question, and only that: *does a daemon
 * that speaks this wire at all hold this rendezvous?* That is what the
 * readiness banner attests, and it is the question the juspay/kolu#2101
 * incident turned on — a previous-epoch daemon accepts the splice and then
 * says nothing, so no amount of in-epoch reasoning can even begin.
 *
 * The parent's admit answers the IN-EPOCH questions — contract skew, build
 * mismatch, the drain budget, the standing anomaly, the degraded chip and the
 * renew affordance. Those already work, end to end, and they are the arms
 * drishti has tested since W6. Nothing about running a front on the remote box
 * makes the parent a worse authority for them; the parent is the only one of
 * the two with a UI.
 *
 * ## So the front never drains, and never refuses over a version
 *
 * `not-drainable` is the structural statement of that: with no drain arms and
 * no budget spellable, a front CANNOT quietly grow into a second adjudicator of
 * skew. `refuse` on contract skew and `nudge-human` on build mismatch both mean
 * "leave the survivor standing and report it" — the front reads the resident's
 * identity, finds it in-epoch (it answered `hello`, which is what being in-epoch
 * MEANS), and relays so the parent can do its job.
 *
 * What the front does still enact is the one thing only it can: taking over a
 * peer the probe classifies UNSPEAKABLE — mute past the silence deadline, or an
 * undecodable first frame — corroborated against the gate file and the pid
 * table that exist only on that box. That path is driven by the probe's
 * classification, not by these arms, which is why it survives `not-drainable`
 * (a mute daemon has no drain verb to call; it is signalled, not asked).
 */
export function drishtiAgentFrontConvergencePolicy(binderBuildId: string) {
  return {
    capability: "not-drainable",
    baked: {
      contractVersion: AGENT_SURFACE_VERSION,
      build: daemonBuild(binderBuildId),
    },
    onContractSkew: { kind: "refuse" },
    onBuildMismatch: { kind: "nudge-human" },
  } as const satisfies ConvergencePolicy<"not-drainable">;
}
