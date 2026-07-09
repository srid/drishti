/**
 * Admin-surface router.
 *
 * Serves THREE siblings over the one admin transport, all on the socket the
 * browser opens once at `/rpc/ws?host=__admin__`:
 *
 *   - `admin`      — drishti's own host-lifecycle PROCEDURES
 *                     (add/remove/reconnect/recheck). No collection of its
 *                     own any more (see `admin-surface.ts`'s docstring).
 *   - `surfaceApp` — the global build-identity `buildInfo` cell + the
 *                     `identity.info` restart probe (kolu#1197/#1201).
 *   - `hosts`      — the `@kolu/surface-map` HOST MAP (`hostMap.ts`):
 *                     `serveHostMap` folds the warm session pool's
 *                     membership + each session's connection state into the
 *                     map's `entries` collection (the `EntryStatus` fact the
 *                     tab strip / fleet cards read), and key-folds every
 *                     `browserSurface` primitive so a host's own data rides
 *                     THIS transport instead of a dedicated `?host=` socket.
 *
 * The first two are keyed siblings via `implementSurfaces`/
 * `composeSurfaceContracts` (`adminContract`); the map is a THIRD key
 * spliced in afterward — `serveSurfaceMap`'s router shape (`{ surface: {
 * <folded members>, entries } }`) is a flat single-surface object, not a
 * multi-sibling `implementSurfaces` input, so it's nested under the `hosts`
 * key exactly the way kolu nests its own padi map under `padi` in
 * `packages/server/src/index.ts`.
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

import { oc } from "@orpc/contract";
import { implement } from "@orpc/server";
import { directLink } from "@kolu/surface/links/direct";
import { implementSurfaces, inMemoryChannelByName } from "@kolu/surface/server";
import { serveHostMap } from "@kolu/surface-remote";
import { surfaceAppServer } from "@kolu/surface-app/server";
import { adminContract, adminSurfaces } from "../common/admin-surface";
import { hostSurfaceMap } from "../common/hostMap";
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
  // `buildInfo` cell + the `identity.info` restart probe) under the
  // `surfaceApp` key. They are NOT merged — `implementSurfaces` keys each
  // surface, serving them at `/surface/admin/…` and `/surface/surfaceApp/…`
  // with a key-namespaced channel per surface.
  //
  // `surfaceAppServer()` supplies surface-app's whole server side in one call:
  // the build-identity cell store (commit resolved once: SURFACE_APP_COMMIT env
  // → git → "dev"; the same commit is baked into the client bundle via
  // build.ts's Bun.build define, so client and server stamp one value and skew
  // is detectable across deploys) AND the `identity.info` probe impl (one
  // processId per process — restart the parent → new id → the control-plane
  // status flips to "restarted"). The buildInfo cell's async republish is fired
  // by the surface runtime — no app-visible connect.
  // `adminSurfaces` (the keyed surface map) is the single source shared with
  // the contract (`composeSurfaceContracts`) and the client (`surfaceClients`);
  // here we add only the server-only per-surface deps, keyed the same way.
  // Per-key deps are typed against each surface's own spec now (kolu#1201), so
  // the concretely-typed admin / surface-app deps bind directly — no cast.
  // `surfaceAppServer()` mints this process's `processId` (no override passed),
  // and now EXPOSES it — so the stale-tab handshake gate in `main.ts` compares a
  // reconnecting tab's `pid` against the SAME id `identity.info` reports, rather
  // than minting a second one that would never match.
  const surfaceApp = surfaceAppServer();
  const { router: surfacesRouter } = implementSurfaces(
    adminSurfaces,
    { channel: inMemoryChannelByName() },
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
            add: async ({ input }: { input: { host: string } }) => {
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
            },
            remove: async ({ input }: { input: { host: string } }) => {
              if (!opts.pool.has(input.host)) return { ok: false };
              try {
                await opts.pool.remove(input.host);
              } catch (err) {
                log(`remove ${input.host} failed: ${(err as Error).message}`);
                return { ok: false };
              }
              return { ok: true };
            },
            reconnect: ({ input }: { input: { host: string } }) => {
              // No `entries` publish here either: membership is unchanged.
              // The session's copying→connecting→connected transition
              // streams back through the per-host `connection` cell AND the
              // map's fused per-session `onState` → `EntryStatus` republish.
              if (!opts.pool.has(input.host)) return { ok: false };
              opts.pool.reconnect(input.host);
              return { ok: true };
            },
            recheck: () => {
              // Fleet-wide force-reprobe (browser regained connectivity /
              // refocused). Like `reconnect`, no membership change; each
              // host's recovery streams back through its own `connection`
              // cell and `EntryStatus`.
              opts.pool.recheckAll();
              return { ok: true };
            },
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
  // deleted. `linkFor` builds (and the adapter caches) a `directLink` over each
  // host's own `buildRouter(...)` — the SAME per-host bridge (agent mirror +
  // kill forward) that used to back a dedicated `?host=` `RPCHandler`, folded
  // into the map's one combined link instead of a separate socket.
  //
  // `offsetOf: () => 0` is drishti's OWN honest offset story: the clock offset
  // is no longer a type BOUND on the session (which is exactly what forced the
  // clone — drishti's ssh sessions measure none), it's an INJECTED capability.
  // drishti stamps every metric with the PARENT's own clock, never a
  // host-stamped one, so there is no true offset being hidden behind the `0`.
  // `causeFor` is omitted — drishti carries no domain failure-cause taxonomy,
  // so a down entry rides through cause-less and the map's `projectStatus`
  // falls back to `"other"` (reads amber/in-motion, never a red "needs you").
  const hostsMap = serveHostMap(hostSurfaceMap, opts.pool, {
    linkFor: (host, session) =>
      directLink(buildRouter({ host, session }).router),
    offsetOf: () => 0,
  });

  // `implement(adminContract).router(...)` WALKS `adminContract` to build the
  // runtime router — `adminContract` (the CLIENT-shared, 2-sibling contract)
  // knows nothing about `hosts`, so an oRPC-blessed `.router()` call against
  // it silently has no route for `hosts.entries`/`hosts.<member>` no matter
  // what extra keys the handlers object carries (confirmed live: the
  // `entries` subscription 404s). A SERVER-ONLY WIDENED contract is
  // required — mirroring kolu's own `servedContract` (`packages/server/src/
  // surface.ts`), which composes the client contract + `padiHostMap.contract`
  // the identical way. `hostSurfaceMap.contract` is `SurfaceMapContract`
  // (structurally `{ surface: { <member>: contract, entries: contract } }`,
  // the contract-level twin of `serveSurfaceMap`'s router shape) — spread its
  // `.surface` in as the `hosts` key, never shared with the client (the
  // client dials the map SEPARATELY via `connectSurfaceMap`, never through
  // this widened contract).
  const servedAdminContract = oc.router({
    ...adminContract,
    surface: {
      ...adminContract.surface,
      // biome-ignore lint/suspicious/noExplicitAny: SurfaceMapContract is AnyContractRouter; its `.surface` is the folded map fragment (mirrors kolu's identical cast in surface.ts).
      hosts: (hostSurfaceMap.contract as any).surface,
    },
  });

  // Splice the map's flat `{ surface: { <folded members>, entries } }`
  // router in under the `hosts` key, beside `admin`/`surfaceApp` —
  // `surfacesRouter` (straight off `implementSurfaces`) is a plain object,
  // so merging here reads its `.surface` directly. Mirrors kolu's own
  // `surfaceRouter.surface = { ...koluSurfaceRouter.surface, padi: … }`.
  const router = implement(servedAdminContract).router({
    ...surfacesRouter,
    surface: {
      ...surfacesRouter.surface,
      hosts: (hostsMap.router as { surface: Record<string, unknown> })
        .surface,
    },
  });

  // `processId` is this parent process's live id — `main.ts`'s WS-upgrade gate
  // feeds it to `rejectStaleProcess` so a tab that reconnects after a parent
  // restart is rejected at the handshake.
  return {
    router,
    processId: surfaceApp.processId,
    /** Tear down the map's own machinery — `serveHostMap.dispose()` tears down
     *  `serveSurfaceMap`'s membership republish sub PLUS the adapter's fused
     *  per-member `onState` subs and cached links in one call. Called from
     *  `main.ts`'s `shutdown()`, alongside `pool.destroyAll()`. */
    disposeHostMap: () => {
      hostsMap.dispose();
    },
  };
}
