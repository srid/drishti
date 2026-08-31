/**
 * Admin-surface router.
 *
 * Serves THREE siblings over the one admin transport, all on the socket the
 * browser opens once at `/rpc/ws?host=__admin__`:
 *
 *   - `admin`      — drishti's own host-lifecycle PROCEDURES
 *                     (add/remove/reconnect/recheck). No collection of its
 *                     own any more (see `admin-surface.ts`'s docstring).
 *   - `surfaceApp` — the global build-identity `buildInfo`
 *                     cell (kolu#1197/#1201); the restart axis is the
 *                     framework-reserved `system/identity` member.
 *   - `hosts`      — the `@kolu/surface-map` HOST MAP (`hostMap.ts`):
 *                     `serveHostMap` folds the warm session pool's
 *                     membership + each session's connection state into the
 *                     map's `entries` collection (the `EntryStatus` fact the
 *                     tab strip / fleet cards read), and key-folds every
 *                     `browserSurface` primitive so a host's own data rides
 *                     THIS transport instead of a dedicated `?host=` socket.
 *
 * The first two are keyed siblings via `implementSurfaces`; the map is served
 * separately and MERGED in. On a flat tag namespace that merge is the whole
 * splice: `serveSurfaceMap` already binds at full wire tags with the `hosts/`
 * prefix baked in (`hostSurfaceMap.name`), so nothing here re-prefixes,
 * re-adapts, or widens a contract to make room for it. See the merge below
 * for what that replaced.
 *
 * `hosts.add` / `hosts.remove` still hand off to the pool for the session
 * side effects (spawn/destroy, persist to disk) — the map's `MapRegistry`
 * is membership + resolution, never a write API, so these mutations stay
 * OUTSIDE it, mirroring kolu's own root `hosts.add`/`hosts.remove`. The
 * map republishes `entries` on its own once the pool's membership /
 * per-session state changes; there is no manual channel-publish call left
 * here to order against (contrast the OLD `hosts` collection, whose
 * `ctx.admin.collections.hosts.upsert/remove` calls this file used to make
 * by hand after every mutation).
 */

import { mergeDisjointGroups } from "@kolu/surface/define";
import { directDispatch } from "@kolu/surface/links/direct";
import {
  implementSurfaces,
  type SurfaceHandlers,
} from "@kolu/surface/server";
import { serveHostMap } from "@kolu/surface-remote";
import { sessionConnection } from "@kolu/surface-remote/connection";
import { surfaceAppServer } from "@kolu/surface-app/server";
import { Effect } from "effect";
import { adminComposed, adminSurfaces } from "../common/admin-surface";
import { hostSurfaceMap } from "../common/hostMap";
import {
  emptyDaemonStatus,
  projectConvergenceAnomaly,
  projectDaemonStatus,
} from "./daemonStatusProjection";
import type { HostPool } from "./hostRegistry";
import { makeLogger } from "./log";
import { buildRouter } from "./router";

const log = makeLogger("admin");

export interface AdminRouterOptions {
  pool: HostPool;
}

export function buildAdminRouter(opts: AdminRouterOptions) {
  // Two SIBLING surfaces over the one admin transport (kolu#1197/#1201):
  // drishti's OWN `admin` surface (the host-lifecycle procedures) under the
  // `admin` key, and surface-app's COMPLETE surface (the build-identity
  // `buildInfo` cell) under the
  // `surfaceApp` key. They are NOT merged — `implementSurfaces` keys each
  // surface, serving them at `/surface/admin/…` and `/surface/surfaceApp/…`
  // with a key-namespaced channel per surface.
  //
  // `surfaceAppServer()` supplies surface-app's whole server side in one call:
  // the build-identity cell store (commit resolved once: SURFACE_APP_COMMIT env
  // → git → "dev"; the same commit is baked into the client bundle via
  // build.ts's Bun.build define, so client and server stamp one value and skew
  // is detectable across deploys). The restart axis is NOT here: it is the
  // framework-reserved `system/identity` member every surface answers (one
  // processId per process — restart the parent → new id → the control-plane
  // status flips to "restarted"). The buildInfo cell's async republish is fired
  // by the surface runtime — no app-visible connect.
  // `adminSurfaces` (the keyed surface map) is the single source shared with
  // the contract (`composeSurfaceContracts`) and the client (`surfaceClients`);
  // here we add only the server-only per-surface deps, keyed the same way.
  // Per-key deps are typed against each surface's own spec now (kolu#1201), so
  // the concretely-typed admin / surface-app deps bind directly — no cast.
  // `surfaceAppServer()` no longer mints or exposes a `processId`, and the gate in
  // `main.ts` no longer takes one: a process has ONE identity —
  // `surfaceProcessId()` (`@kolu/surface/identity`) — which the framework-reserved
  // `system/identity` member answers with and which the gate compares against, so
  // there is nothing left for a consumer to keep in step (juspay/kolu#2133).
  const surfaceApp = surfaceAppServer();
  const surfaces = implementSurfaces(
    adminSurfaces,
    // The ordinary constructor owns its in-memory channel internally now.
    {},
    {
      // ── surface-app served as a sibling ──────────────────────────────
      // `surfaceAppServer()` is the surface-app deps bundle; pass it directly.
      surfaceApp,

      // ── drishti's own admin surface served as a sibling ──────────────
      // Procedures only now — the `hosts` collection is gone (replaced by
      // the host map's `entries` below).
      admin: {
        procedures: {
          hosts: {
            add: ({ input }: { input: { host: string } }) =>
              Effect.promise(async () => {
                // `HostInputSchema` already rejects blank, whitespace-containing,
                // and sentinel strings at validation time; no re-check needed here.
                const host = input.host.trim();
                if (opts.pool.has(host)) {
                  return { ok: false, error: "host already exists" };
                }
                try {
                  await opts.pool.add(host);
                } catch (err) {
                  return { ok: false, error: (err as Error).message };
                }
                // No manual publish: `serveHostMap`'s membership fuse (wired
                // below) republishes the map's `entries` collection off the
                // SAME `pool.subscribe` this `add` just satisfied.
                return { ok: true };
              }),
            remove: ({ input }: { input: { host: string } }) =>
              Effect.promise(async () => {
                if (!opts.pool.has(input.host)) return { ok: false };
                try {
                  await opts.pool.remove(input.host);
                } catch (err) {
                  log(`remove ${input.host} failed: ${(err as Error).message}`);
                  return { ok: false };
                }
                return { ok: true };
              }),
            reconnect: ({ input }: { input: { host: string } }) =>
              Effect.sync(() => {
                // No `entries` publish here either: membership is unchanged.
                // The session's probing→provisioning→connecting→connected transition
                // streams back through the per-host `connection` cell AND the
                // map's fused per-session `onState` → `EntryStatus` republish.
                if (!opts.pool.has(input.host)) return { ok: false };
                opts.pool.reconnect(input.host);
                return { ok: true };
              }),
            recheck: () =>
              Effect.sync(() => {
                // Fleet-wide force-reprobe (browser regained connectivity /
                // refocused). Like `reconnect`, no membership change; each
                // host's recovery streams back through its own `connection`
                // cell and `EntryStatus`.
                opts.pool.recheckAll();
                return { ok: true };
              }),
            renew: ({ input }: { input: { host: string } }) =>
              Effect.promise(async () => {
                // W7: manual build-axis replace via HostSession.renew.
                if (!opts.pool.has(input.host)) {
                  return { ok: false, error: "host not found" };
                }
                const session = opts.pool.getSession(input.host);
                if (session === undefined) {
                  return { ok: false, error: "host session missing" };
                }
                try {
                  await session.renew();
                  // After a successful drain the session should re-dial; force
                  // reconnect so the successor comes up without waiting for
                  // idle teardown paths.
                  opts.pool.reconnect(input.host);
                  return { ok: true };
                } catch (err) {
                  return { ok: false, error: (err as Error).message };
                }
              }),
            convergence: ({ input }: { input: { host: string } }) =>
              Effect.sync(() => {
                // W7: project HostSession.convergence() for honest UI / tests.
                if (!opts.pool.has(input.host)) {
                  return { anomaly: null };
                }
                const session = opts.pool.getSession(input.host);
                if (session === undefined) {
                  return { anomaly: null };
                }
                const c = session.convergence();
                if (c === null) return { anomaly: null };
                return { anomaly: projectConvergenceAnomaly(c) };
              }),
            daemonStatus: ({ input }: { input: { host: string } }) =>
              Effect.sync(() => {
                if (!opts.pool.has(input.host)) {
                  return emptyDaemonStatus("unknown");
                }
                const session = opts.pool.getSession(input.host);
                if (session === undefined) {
                  return emptyDaemonStatus("unknown");
                }
                return projectDaemonStatus(session);
              }),
          },
        },
      },
    },
  );

  // ── The host MAP — serve every pool member's `browserSurface`, keyed by
  // host, over THIS transport. `serveHostMap` (`@kolu/surface-remote`) IS the
  // pool → `SurfaceMap` adapter: it fuses `opts.pool`'s membership + each
  // session's `onState` into the map's `entries`, projects `SessionState` →
  // `EntryStatus`, and hands the composed registry to `serveSurfaceMap` — the
  // ~90-line registry drishti used to hand-clone (`hostMapRegistry.ts`), now
  // deleted. `dispatchFor` builds (and the adapter caches) a `directDispatch` over each
  // host's own `buildRouter(...)` — the SAME per-host bridge (agent mirror +
  // kill forward) that used to back a dedicated `?host=` `RPCHandler`, folded
  // into the map's one combined link instead of a separate socket.
  //
  // No `offsetOf` (PR3 removed it): the clock offset is no longer an injected
  // capability NOR a type BOUND on the session — the framework measures it at
  // admit off the reserved `system.clockNow` and rides it on the `connected`
  // arm. drishti stamps every metric with the PARENT's own clock, so it simply
  // reads whatever the framework measures; it fabricates no offset.
  //
  // `failureOf` is REQUIRED and TOTAL now (PR4 — no framework fallback cause).
  // drishti carries no domain taxonomy, so it classifies structurally on the
  // transport phase: a TERMINAL `failed` session is a genuine failure carrying its
  // real transport `error` as the human `reason` (→ a red "failed: <reason>" chip);
  // a `disconnected` (the reconnect-backoff window) returns `null` — "not a standing
  // failure, keep warming" — so a live host's normal reconnect reads amber, never a
  // red chip. This preserves the exact behavior the old omitted-`causeFor` had
  // (disconnected → warming, terminal → failed) without any fabricated cause.
  const hostsMap = serveHostMap(hostSurfaceMap, opts.pool, {
    dispatchFor: (host, session) => directDispatch(buildRouter({ host, session })),
    failureOf: (_host, _session, state) =>
      state.phase === "failed"
        ? { reason: (state as { error: string }).error }
        : null,
    // SR9 — the entry's fine connection payload (the word), co-produced with the coarse
    // dot from the SAME session frame; `sessionConnection` is the shared projection and
    // `isConnected` the discriminant `serveHostMap` asserts the dot against (fail-loud on a
    // dot/word disagreement — the drishti#102 divergence made structurally unspellable).
    connection: {
      project: sessionConnection,
      isConnected: (c) => c.phase === "connected",
    },
  });

  // ── The splice, which is now a record merge ──────────────────────────────
  //
  // This used to be the most delicate ~40 lines in the repo. Under oRPC a
  // contract was a nested MATCHER TREE, and `implement(contract).router(...)`
  // re-adapted finalized routers against it — so the client-shared 2-sibling
  // `adminContract` had no route for `hosts.*` no matter what extra keys the
  // handlers object carried, and a map subscription silently 404'd while
  // everything else stayed green. The fix was a server-only WIDENED contract
  // (`oc.router({...adminContract, surface: {…, hosts: map.surfaceContract}})`)
  // plus an `as any` splice of two opaque runtime routers.
  //
  // On a flat tag namespace a tag carries its own route. `serveSurfaceMap`
  // already binds the map's handlers at their FULL wire tags with the `hosts/`
  // prefix baked in (`hostSurfaceMap.name`), and `implementSurfaces` does the
  // same for the two siblings — so the host merges two `{group, handlers}`
  // pairs and there is nothing left to widen, re-adapt, or cast.
  const group = mergeDisjointGroups({
    adminSiblings: surfaces.group,
    hostMap: hostsMap.group,
  });
  const handlers: SurfaceHandlers = Object.create(null);
  for (const [tag, handler] of [
    ...Object.entries(surfaces.handlers),
    ...Object.entries(hostsMap.handlers),
  ]) {
    if (tag in handlers) {
      throw new Error(
        `buildAdminRouter: two handlers bound at wire tag "${tag}" — the admin ` +
          "siblings and the host map must stay disjoint.",
      );
    }
    handlers[tag] = handler;
  }
  // The group half of that disjointness is the FRAMEWORK's proof now
  // (`mergeDisjointGroups`, juspay/kolu#2222): `RpcGroup.merge` is a
  // last-writer-wins `Map.set` with no collision detection, and the counted
  // merge above throws naming the tag and both halves rather than leaving a
  // swallowed tag to answer under the other's schema. It replaces the hand-rolled
  // size check this file used to carry, and it is the successor to the deleted
  // matcher-tree reasoning: route-set identity, in both directions, is what "the
  // map is actually served" means now.
  if (Object.keys(handlers).length !== group.requests.size) {
    throw new Error(
      `buildAdminRouter: ${Object.keys(handlers).length} handler(s) bound for ` +
        `${group.requests.size} advertised tag(s) — an advertised tag nobody bound ` +
        "404s at the far end, and a handler at an unminted tag is dead code.",
    );
  }

  // No `processId` is handed out any more. `main.ts`'s WS-upgrade gate reads this
  // process's own `surfaceProcessId()` — the same value the framework-reserved
  // `system/identity` member answers with, and so the same one a reconnecting tab
  // echoes back — leaving nothing to thread from here (juspay/kolu#2133).
  return {
    group,
    handlers,
    /** Tear down the map's own machinery — `serveHostMap.dispose()` tears down
     *  `serveSurfaceMap`'s membership republish sub PLUS the adapter's fused
     *  per-member `onState` subs and cached links in one call. Called from
     *  `main.ts`'s `shutdown()`, alongside `pool.destroyAll()`. */
    disposeHostMap: () => {
      hostsMap.dispose();
    },
  };
}
