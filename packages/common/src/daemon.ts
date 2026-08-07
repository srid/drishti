/**
 * The parent↔agent DAEMON control plane — drishti's own sibling surface beside
 * the framework's frozen control core, plus the composed wire both ends build
 * from.
 *
 * ## Why drishti owns a drain verb at all
 *
 * `@kolu/surface-daemon`'s frozen `control.core.drain` declares **no output and
 * no error**, and in the Effect epoch a rejecting `onDrain` hook is a DEFECT —
 * "a daemon whose drain hook throws is broken, not busy". drishti's final
 * history-ring write can legitimately FAIL (a full disk, a read-only home)
 * while the daemon itself is perfectly healthy, and the parent must never
 * present that as a clean drain: it stands the host at
 * `drained-with-persist-failure` so the operator knows the successor booted
 * from a stale ring.
 *
 * That verdict is therefore not an error at all — it is part of a SUCCESSFUL
 * drain's outcome, and it needs a channel the frozen fragment does not have.
 * The pre-Effect code smuggled it through `ORPCError("DRISHTI_PERSIST_FAILED")`
 * on the frozen channel; there is no honest translation of that, so the channel
 * is redesigned rather than ported: drishti declares its own drain verb, on its
 * own sibling, returning the verdict as a **declared value**.
 *
 * ## Why a SIBLING and not a member of the app surface
 *
 * The app surface is re-served verbatim to the BROWSER (`browserSurface` in
 * `./browser.ts`, and the parent's own `implementSurface(mirroredAgentSurface)`
 * in `app/src/server/router.ts`). A drain verb there would hand every browser
 * tab the authority to stop any host's daemon. As a sibling it lives on exactly
 * the parent↔agent wire the frozen control core does, and the mirror never sees
 * it.
 *
 * ⚠ This module imports `@kolu/surface-daemon`, so it is AGENT+PARENT only —
 * never reach it from `./surface.ts` or `./browser.ts` (the browser bundle
 * would grow a daemon dependency it can neither use nor resolve).
 */

import { controlCoreSurface } from "@kolu/surface-daemon";
import {
  composeSurfaceContracts,
  defineSurface,
  type Surface,
} from "@kolu/surface/define";
import { Schema } from "effect";
import { surface } from "./surface";

/** What `daemon.ring.drain` answers with.
 *
 *  `persisted: false` means the daemon drained and its FINAL durable-ring write
 *  did not land — the successor will boot from a stale ring. `error` is
 *  `Schema.optionalKey` (#17 law): a clean drain OMITS the key rather than
 *  sending `"error":null`, the same shape `process.kill` uses for its own
 *  failure reason. */
export const DrainVerdictSchema = Schema.Struct({
  persisted: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
export type DrainVerdict = typeof DrainVerdictSchema.Type;

/**
 * drishti's daemon control sibling: drain this daemon and SAY whether the final
 * ring write landed.
 *
 * It is a strict superset of the frozen `control.core.drain` — same flush, same
 * lifetime abort, plus the verdict — so the parent calls this one and never the
 * frozen one. The frozen verb stays implemented and stays generic: a supervisor
 * that only speaks the frozen fragment still gets a correct final write, it
 * just does not learn the verdict. Both verbs drive the SAME latched drain, so
 * calling them in either order flushes exactly once.
 */
export const daemonControlSurface = defineSurface({
  procedures: {
    ring: {
      drain: { output: DrainVerdictSchema },
    },
  },
});

/** The three surfaces the agent daemon serves, as one keyed map — the single
 *  source of truth for the agent's `implementSurfaces` and the parent's dial.
 *  Deriving both sides from this one value is what makes the served group and
 *  the dialled group provably the same tag set. */
export const agentDaemonSurfaces = {
  app: surface,
  control: controlCoreSurface,
  daemon: daemonControlSurface,
} as const;

/** The composed wire: one flat `RpcGroup` over `surface/{app,control,daemon}/…`
 *  plus a per-sibling `Surface` to build each face from. */
export const agentDaemonComposed =
  composeSurfaceContracts(agentDaemonSurfaces);

/**
 * The value the parent hands `sshConnector` / `dialAgentOnce`.
 *
 * `spec` + `tagPrefix` are the APP sibling's, so the connector's own face is
 * the app-scoped client every consumer already expects
 * (`client.surface.system`, `client.surface.processes`, …). `group` is the
 * COMBINED one, because the link builds a single RPC client and that client
 * must know every tag the daemon serves — including the control and daemon
 * siblings', whose faces the parent builds separately over the SAME
 * `Connection.dispatch`. (kolu's kaval assembles its daemon the same way: one
 * merged group, several faces.)
 */
export const agentDialSurface: Surface<typeof surface.spec> = {
  ...agentDaemonComposed.siblings.app,
  group: agentDaemonComposed.group,
};

/** The frozen control-core sibling — build the `control.core.{hello,drain}`
 *  face from THIS value, never from `controlCoreSurface` directly, or the tags
 *  lose the `control/` sibling segment the agent bound them at. */
export const agentControlSurface = agentDaemonComposed.siblings.control;

/** drishti's own daemon sibling — the face carrying `ring.drain`. */
export const agentDrainSurface = agentDaemonComposed.siblings.daemon;
