/**
 * Admin surface — the host-lifecycle PROCEDURES (add/remove/reconnect/
 * recheck).
 *
 * Host MEMBERSHIP + STATUS used to live here as a hand-rolled `hosts`
 * collection; that collection is DELETED — it is now the `@kolu/surface-map`
 * host map's OWN `entries` collection (`hostMap.ts`, served by
 * `serveHostMap` in `admin-router.ts`, consumed by `connectSurfaceMap` in
 * `wire.ts`). This surface keeps only the MUTATIONS, which the map
 * deliberately doesn't own (`MapRegistry` is membership + resolution, not a
 * write API) — mirroring kolu's own root `hosts.add`/`hosts.remove`
 * procedures, which also sit outside the map they mutate.
 *
 * Volatility-distinct from the per-host `surface` (system / processes /
 * cpuCores / connection): admin mutates on user action (add/remove)
 * rather than per poll tick.
 *
 * Served at `/rpc/ws?host=__admin__` — the reserved sentinel
 * (`ADMIN_HOST_SENTINEL`, defined in `./host`) and the upgrade handler in
 * `server/main.ts`. This is now the ONE browser socket for the whole app:
 * every host's own data (previously a dedicated `?host=` socket per host)
 * rides the SAME transport, folded through the host map's `{ mapKey, input
 * }` wire envelope.
 *
 * The admin connection is also drishti's CONTROL PLANE: the one
 * always-open, global connection. surface-app's build-identity surface
 * (the `buildInfo` cell + the `identity.info` restart probe) rides this
 * same transport — but as a SIBLING surface, NOT merged into the admin
 * surface (kolu#1197/#1201). `composeSurfaceContracts` multiplexes the
 * two: drishti's own `admin` surface under the `admin` key, surface-app's
 * complete surface under the `surfaceApp` key. Each is namespaced by its
 * key on the wire (`/surface/admin/…` vs `/surface/surfaceApp/…`); the
 * host map rides a THIRD key, `hosts` (spliced in by `admin-router.ts` /
 * dialled via `connectSurfaceMap(hostSurfaceMap, conn.transport, "hosts")`
 * in `wire.ts` — outside `composeSurfaceContracts`, exactly like kolu's own
 * padi map).
 */

import { composeSurfaceContracts, defineSurface } from "@kolu/surface/define";
import { surfaceAppSurface } from "@kolu/surface-app/surface";
import { Schema } from "effect";
import {
  ConvergenceAnomalyWireSchema,
  DaemonStatusSchema,
} from "./daemonStatus";
import { isValidHost } from "./host";

/** The ssh-injection boundary. `isValidHost` stays the ONE predicate (see
 *  `./host`); this is only its wire wrapper, so the message a rejected
 *  `hosts.add` shows in the UI is preserved verbatim. */
const HostInputSchema = Schema.String.check(
  Schema.makeFilter<string>((host) =>
    isValidHost(host)
      ? undefined
      : "host must be non-empty, have no whitespace, not start with '-', and not be the admin sentinel",
  ),
);

/** The shape five of the seven procedures take: one host. */
const HostArgSchema = Schema.Struct({ host: Schema.String });
/** A bare acknowledgement. */
const OkSchema = Schema.Struct({ ok: Schema.Boolean });
/** An acknowledgement that may carry a reason. `Schema.optionalKey`, never
 *  `Schema.optional` (#17): a success OMITS `error` rather than sending
 *  `"error":null`, exactly as zod's `.optional()` did. */
const OkOrErrorSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});

/** drishti's OWN admin surface — just the host-lifecycle procedures.
 *  surface-app's buildInfo/identity ride the sibling surface, and host
 *  membership/status ride the `hosts` MAP sibling; neither lives here. */
export const adminSurface = defineSurface({
  procedures: {
    hosts: {
      add: {
        input: Schema.Struct({ host: HostInputSchema }),
        output: OkOrErrorSchema,
      },
      remove: {
        input: HostArgSchema,
        output: OkSchema,
      },
      // Re-arm a host whose parent session gave up (its `connection`
      // cell is `failed`). Distinct from add/remove: it mutates session
      // lifecycle, not host-set membership — the host stays configured,
      // so this never touches the map's `entries` collection. The
      // recovery flows back through the per-host `connection` cell AND
      // the map's own `EntryStatus` projection, not here.
      reconnect: {
        input: HostArgSchema,
        output: OkSchema,
      },
      // Force a fresh link probe on every host — the browser fires this on
      // regaining connectivity (`online`) or refocus (`visibilitychange`),
      // the client-side companion to the parent's own wake monitor. No
      // input (it's fleet-wide) and no host-set change; like `reconnect`,
      // recovery is observed via each host's `connection` cell and the
      // map's `EntryStatus`.
      recheck: {
        input: Schema.Struct({}),
        output: OkSchema,
      },
      // W7: build-axis replace — drain + await exit via control-core (HostSession.renew).
      // After renew the session reconnect machinery spawns the successor.
      renew: {
        input: HostArgSchema,
        output: OkOrErrorSchema,
      },
      // W7: standing convergence anomaly for a host (adopted-stale / skew /
      // unconverged / cross-supervisor / link-failed), or null when clean.
      // Typed kind + detail for minimal honest UI projection.
      convergence: {
        input: HostArgSchema,
        output: Schema.Struct({
          anomaly: Schema.NullOr(ConvergenceAnomalyWireSchema),
        }),
      },
      // UI phase: full typed daemon status for chip + dialog (outcome, identity,
      // anomaly with structured evidence, phase). Superset of convergence.
      daemonStatus: {
        input: HostArgSchema,
        output: DaemonStatusSchema,
      },
    },
  },
});

/** surface-app served as a SIBLING of the admin surface — drishti uses the
 *  DEFAULT build identity (`{ commit }`), so it takes the library's
 *  `surfaceAppSurface` directly (no `surfaceAppSurfaceWith`). Re-exported so
 *  the server (`implementSurfaces`) and client (`surfaceClients`) bind the
 *  same surface instance. */
export { surfaceAppSurface };

/** The two siblings, keyed. Both server and client iterate this same map,
 *  so the keys can't drift. */
export const adminSurfaces = {
  admin: adminSurface,
  surfaceApp: surfaceAppSurface,
} as const;

/**
 * The two siblings COMPOSED — `{ group, siblings }` over a flat tag namespace
 * (`surface/admin/…`, `surface/surfaceApp/…`).
 *
 * There is no `adminContract` any more, and its absence is the point. Under
 * oRPC a contract was a nested matcher tree, so the server had to hand-build a
 * WIDENED server-only copy (`oc.router({...adminContract, surface: {…,
 * hosts: …}})`) and re-adapt the finalized routers through it just to splice
 * the host map in — the single most delicate ~40 lines in the repo, and the
 * reason a map subscription could 404 while everything else stayed green. On a
 * flat wire a tag carries its own route, so the splice is a record merge and
 * the widened copy has nothing left to do.
 */
export const adminComposed = composeSurfaceContracts(adminSurfaces);
