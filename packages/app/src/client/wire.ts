/**
 * Client-side surface bundle — ONE WebSocket for the whole app.
 *
 * Every configured host used to get its own `PartySocket` via
 * `connectSurface`; that's DELETED (`@kolu/surface-map` adoption). Now the
 * admin socket — drishti's control plane (host set + the surface-app
 * sibling) — is the ONLY connection. Every host's own data (`system` /
 * `cpuCores` / `processesSnapshot` / `connection` / …) rides the SAME
 * transport, key-folded through the `hosts` host MAP
 * (`../common/hostMap.ts`): `connectSurfaceMap(hostSurfaceMap,
 * conn.transport, "hosts")` slices the map's link off the admin socket's
 * BRANDED handle, so every host chip's dot floors on the SAME real
 * transport liveness the control plane already watches — there is no
 * second socket, no second half-open watchdog, and no per-host
 * `disposeHostSurface` left to call on removal (a departed host's live
 * subs end typed, over this one socket, the instant the server's `entries`
 * drops the key).
 *
 * `connectSurfaces` wires the half-open liveness heartbeat — probing the
 * framework-reserved `system.live` round-trip — BY CONSTRUCTION, and its
 * BRANDED transport handle is what `connectSurfaceMap` requires (never a
 * raw link), so a silently half-open connection can no longer paint a
 * green host-map dot either.
 */

import { createProcessIdEcho } from "@kolu/surface-app/connect";
import { createNotify } from "@kolu/surface-app/notify";
import { connectSurfaces } from "@kolu/surface-app/solid";
import { connectSurfaceMap } from "@kolu/surface-map/client";
import { adminSurfaces } from "../common/admin-surface";
import { ADMIN_HOST_SENTINEL } from "../common/host";
import { hostSurfaceMap } from "../common/hostMap";

// ONE `pid` echo for the ONE socket. The parent mints a fresh `processId`
// per boot; the echo threads the last-known one back as the `pid` query
// param on every (re)connect so the parent recognizes a stale tab after a
// restart and rejects it at the handshake. `App.tsx` feeds this via the
// provider's `onProcessId` callback (the turnkey `{ ws, probe }` source
// publishes each observed id); it's null until the first probe, so the
// first connect omits the param.
const echo = createProcessIdEcho();
export const rememberServerProcessId = echo.remember;

// The ONE WS URL — WITHOUT the `pid` (the echo appends it). `host=` is kept
// as the routing sentinel `main.ts`'s upgrade handler still checks, though
// there is now exactly one thing it can route to.
function wsBase(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/rpc/ws?host=${encodeURIComponent(ADMIN_HOST_SENTINEL)}`;
}

// Cold start can take 30+ seconds while the parent provisions the FIRST
// host's agent via `nix copy`, so the connect deadline is bumped well past
// partysocket's 4s default — without this, the socket flaps repeatedly
// during the first connect.
const BASE_SOCKET_OPTIONS = {
  connectionTimeout: 60_000,
  minReconnectionDelay: 2_000,
  maxReconnectionDelay: 15_000,
} as const;

// The admin transport multiplexes TWO sibling surfaces (kolu#1197/#1201):
// drishti's own `admin` surface (host-lifecycle procedures) and
// surface-app's complete surface (`buildInfo` + the `identity.info` probe).
// `connectSurfaces` splits the one link into a per-key client bundle and
// folds them into ONE `health()` fact (`live` AND-reduced across siblings
// off the one socket). It ALWAYS wires the half-open watchdog (it mints the
// watchdog-backed `LiveSignal` every client — and now the host map too —
// requires). The `<SurfaceAppProvider>` lifecycle over the SAME socket
// (`App.tsx`) opts ITS own watchdog out (`heartbeat={false}`) so the socket
// isn't double-watched; the lifecycle still retires the socket on a
// stale-restart, so this opts out of self-retire (`retireOnStaleClose:
// false`).
const conn = connectSurfaces({
  surfaces: adminSurfaces,
  url: wsBase,
  echo,
  socketOptions: BASE_SOCKET_OPTIONS,
  retireOnStaleClose: false,
});

export const ws = conn.ws;

// ── The host MAP — a keyed map of remote surfaces: ONE entry surface
//    (`browserSurface`) served N times, keyed by host. `host` is no longer a
//    dedicated socket — every host's `system`/`cpuCores`/`processesSnapshot`/
//    `connection` rides `hostMap.entry(host)` (a pure point lens) or
//    `hostMap.useEntry(activeHost)` (a reactive lens that re-keys on
//    switch). The map is dialled over the `hosts` SIBLING of `conn`'s
//    BRANDED transport handle: `connectSurfaceMap` slices `hosts` from it
//    and recovers the parent `connectSurfaces` watchdog `live` by
//    construction (the handle is unforgeable), so every chip floors on the
//    real socket — there is no raw `{ live }` seam to pass a
//    green-over-dead accessor through.
export const hostMap = connectSurfaceMap(hostSurfaceMap, conn.transport, "hosts");

// The origin's ONE notification seam (kolu W5, `@kolu/surface-app/notify`) —
// the last hop of cross-host attention. App-scoped alongside the host map it
// draws from: `App.tsx`'s `watchByEntry` over `hostMap` fires `notify.show`
// per newly-raised alert, and `notify.onClick` routes a click's `{ host, id }`
// back to drill into that host. The payload shape `D` is drishti's own routing
// key — the framework carries it opaquely and hands it back verbatim.
export const notify = createNotify<{ host: string; id: string }>((data) => {
  // Validate the click envelope the framework relays (a live postMessage or a
  // cold-start URL param) before routing — a stale/pre-upgrade notification, or a
  // `{}` a degraded worker substitutes, is dropped rather than routed to
  // `expandHost(undefined)`. Both fields are plain strings here (a host key and a
  // metric-series id), so a shape check is the whole validation.
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.host !== "string" || typeof d.id !== "string") return undefined;
  return { host: d.host, id: d.id };
});

/** The ONE membership-error handler for `hostMap.entries` — shared by every
 *  whole-collection consumer (`App.tsx`'s reconcile effect, `TabStrip`'s
 *  strip) so a membership-stream failure toasts once, not per-consumer. */
export const onHostMembershipError = (err: Error): void => {
  console.error("host membership subscription failed", err);
};

/** The per-host PROCEDURE client — `hostRpc(host).process.kill(...)` resolves at
 *  the map's key-folded wire path. The entry's bound `procedures` face, typed
 *  straight from `browserSurface`'s declaration — NO cast (the narrow `procedures`
 *  map dodges the TS2590 that the raw `entry.rpc` contract client trips on a generic
 *  map). Replaces the old `surfaceForHost(host).rpc`. */
export function hostRpc(host: string) {
  return hostMap.entry(host).procedures;
}

/** Get the admin surface client — drishti's OWN `admin` surface, used for
 *  its host-lifecycle procedures. */
export function adminClient() {
  return conn.clients.admin;
}

/** The admin surface's bound PROCEDURES. `adminRpc().hosts.add(...)` /
 *  `.remove(...)` / `.reconnect(...)` / `.recheck(...)` resolve at
 *  `/surface/admin/hosts/<verb>` — typed from the declaration, no cast. */
export function adminRpc() {
  return conn.clients.admin.procedures;
}

/** The surface-app client over the admin transport — the global
 *  build-identity `buildInfo` cell + the `identity.info` restart probe.
 *  Handed to `<SurfaceAppProvider controlPlane=...>` and
 *  `surfaceAppProbe(...)`. The `surfaceApp` key is consumed by the scope,
 *  so the probe's wire path is `/surface/surfaceApp/identity/info` (the key
 *  does NOT reappear). */
export function surfaceAppClient() {
  return conn.clients.surfaceApp;
}

/** The ONE transport. drishti's control plane — surface-app's
 *  `<SurfaceAppProvider>` observes ITS open/close to derive the connection
 *  lifecycle (paired with the `surfaceApp.info` probe to tell a transient
 *  drop from a parent restart). Every host chip's dot ultimately floors on
 *  this same socket via `hostMap`'s branded transport slice. */
export function adminSocket() {
  return conn.ws;
}
