/**
 * Client-side surface bundle — one WebSocket per host.
 *
 * Each host gets its own surface client over its own `PartySocket` via
 * `connectSurface` (the turnkey seam); the admin surface (host set + the
 * surface-app sibling) gets one more via `connectSurfaces` at the reserved
 * sentinel. Both seams wire the half-open liveness heartbeat — probing the
 * framework-reserved `system.live` round-trip — BY CONSTRUCTION. The hand-built
 * `surfaceClient + websocketLink` path these used to take could (and silently
 * did) skip that heartbeat, so it is gone: there is no constructor left that can
 * forget the watchdog. The admin socket opts the heartbeat OUT (`heartbeat:
 * false`) only because `<SurfaceAppProvider>`'s `createServerLifecycle` already
 * runs one for it — a second would double the probe.
 *
 * The cache keeps the connection stable across Solid component remounts so a tab
 * switch doesn't tear down the socket — only the subscriptions inside it.
 * `disposeHostSurface(host)` disposes a host's connection (stopping its heartbeat
 * and standing subs, then closing the socket) when it leaves the admin collection
 * so the cache doesn't leak.
 */

import type { ContractRouterClient } from "@orpc/contract";
import { createProcessIdEcho } from "@kolu/surface-app/connect";
import { connectSurface, connectSurfaces } from "@kolu/surface-app/solid";
import { adminContract, adminSurfaces } from "../common/admin-surface";
import { ADMIN_HOST_SENTINEL } from "../common/host";
import { browserSurface } from "drishti-common/browser";

// ONE shared `pid` echo across every socket (per-host + admin). The parent mints
// a fresh `processId` per boot; the echo threads the last-known one back as the
// `pid` query param on every (re)connect so the parent recognizes a stale tab
// after a restart and rejects it at the handshake. `App.tsx` feeds this via the
// provider's `onProcessId` callback (the turnkey `{ ws, probe }` source publishes
// each observed id); it's null until the first probe, so the first connect omits
// the param. The connect* seams read it on every reconnect.
const echo = createProcessIdEcho();
export const rememberServerProcessId = echo.remember;

// The base WS URL — WITHOUT the `pid` (the echo appends it). A per-host string is
// built fresh on each reconnect by the seam's URL thunk.
function wsBaseFor(host: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/rpc/ws?host=${encodeURIComponent(host)}`;
}

// Cold start can take 30+ seconds while the parent provisions the agent via
// `nix copy`, so the connect deadline is bumped well past partysocket's 4s
// default — without this, the socket flaps repeatedly during the first connect.
// Shared by every socket the two connect* seams open.
const BASE_SOCKET_OPTIONS = {
  connectionTimeout: 60_000,
  minReconnectionDelay: 2_000,
  maxReconnectionDelay: 15_000,
} as const;

type HostConnection = ReturnType<typeof buildHostSurface>;
type AdminConnection = ReturnType<typeof buildAdminSurface>;

function buildHostSurface(host: string) {
  // `connectSurface` builds the reconnecting socket, the reactive client, AND the
  // default-on half-open heartbeat in one call — so a silently half-open per-host
  // link is detected and force-reconnected instead of left painting stale metrics
  // (the gap the hand-built path had: it threaded `{ live }` off open/close but
  // ran no heartbeat). The socket self-retires on a stale-restart close — no
  // provider watches per-host sockets — so `retireOnStaleClose: true`. The
  // transport leg, and (via `browserSurface`'s `connection` cell `liveWhen`) the
  // mirror leg, both fold into `client.health().live` by construction.
  return connectSurface({
    surface: browserSurface,
    url: () => wsBaseFor(host),
    echo,
    socketOptions: BASE_SOCKET_OPTIONS,
    retireOnStaleClose: true,
  });
}

function buildAdminSurface() {
  // The admin transport multiplexes TWO sibling surfaces (kolu#1197/#1201):
  // drishti's own `admin` surface (the host set + procedures) and surface-app's
  // complete surface (`buildInfo` + the `identity.info` probe). `connectSurfaces`
  // splits the one link into a per-key client bundle and folds them into ONE
  // `health()` fact (`live` AND-reduced across siblings off the one socket).
  // `connectSurfaces` ALWAYS wires the half-open watchdog (it mints the
  // watchdog-backed `LiveSignal` the clients require — there is no `heartbeat:
  // false` that could mint a blind brand). So the admin socket's ONE watchdog
  // lives here; the `<SurfaceAppProvider>` lifecycle over the SAME socket
  // (`App.tsx`) opts ITS own watchdog out (`heartbeat={false}` — it mints no
  // brand) so the socket isn't double-watched. The lifecycle still retires the
  // socket on a stale-restart, so this opts out of self-retire
  // (`retireOnStaleClose: false`).
  return connectSurfaces({
    surfaces: adminSurfaces,
    url: () => wsBaseFor(ADMIN_HOST_SENTINEL),
    echo,
    socketOptions: BASE_SOCKET_OPTIONS,
    retireOnStaleClose: false,
  });
}

const hostCache = new Map<string, HostConnection>();

// `connectSurface`/`connectSurfaces` erase the client's `.rpc` to `unknown`/`any`
// (to dodge TS2590 on their generic seams), so recover the CONCRETE contract for
// imperative procedures here — the runtime link IS this type. The framework's
// blessed "cast `.rpc` to your concrete contract once at the wire boundary".
type HostRpc = ContractRouterClient<typeof browserSurface.contract>;
type HostClient = HostConnection["client"] & { rpc: HostRpc };

/** Get the (cached) surface client for `host`. The first call opens the
 *  socket (and starts its heartbeat); subsequent calls return the same instance
 *  so a tab remount preserves the live connection. */
export function surfaceForHost(host: string): HostClient {
  let entry = hostCache.get(host);
  if (entry === undefined) {
    entry = buildHostSurface(host);
    hostCache.set(host, entry);
  }
  return entry.client as HostClient;
}

/** Dispose the host's connection and drop it from the cache. Stops the heartbeat
 *  and tears down the client's standing subs, then closes the socket — otherwise
 *  the PartySocket keeps reconnecting into a server slot that no longer exists.
 *  Call when the admin collection signals the host was removed. */
export function disposeHostSurface(host: string): void {
  const entry = hostCache.get(host);
  if (entry === undefined) return;
  hostCache.delete(host);
  try {
    entry.dispose();
    entry.ws.close();
  } catch {
    /* best-effort */
  }
}

let adminEntry: AdminConnection | undefined;

function adminEntryLazy(): AdminConnection {
  if (adminEntry === undefined) adminEntry = buildAdminSurface();
  return adminEntry;
}

/** Get the (cached) admin surface client — drishti's OWN `admin` surface,
 *  used for the bound subscription hooks (`adminClient().collections.hosts
 *  .use(...)`). Lazy — opens the admin WS on first call. surface-app's
 *  build-identity surface rides the same transport; reach it via
 *  `surfaceAppClient()`. */
export function adminClient() {
  return adminEntryLazy().clients.admin;
}

// The admin scoped client's `.rpc` is the slice `{ surface: link.surface.admin }`,
// typed `any` by `connectSurfaces`; recover the admin router type so the
// imperative host-lifecycle procedures stay typed.
type AdminScopedRpc = {
  surface: ContractRouterClient<typeof adminContract>["surface"]["admin"];
};

/** The admin surface's PROCEDURE namespace. `adminRpc().hosts.add(...)` /
 *  `.remove(...)` / `.reconnect(...)` / `.recheck(...)` resolve at
 *  `/surface/admin/hosts/<verb>`. Procedure calls go through the scoped rpc
 *  (recovered to its concrete type above), mirroring kolu. */
export function adminRpc() {
  return (adminEntryLazy().clients.admin.rpc as AdminScopedRpc).surface;
}

/** Get the (cached) surface-app client over the admin transport — the global
 *  build-identity `buildInfo` cell + the `identity.info` restart probe. Handed
 *  to `<SurfaceAppProvider controlPlane=...>` and `surfaceAppProbe(...)`. The
 *  `surfaceApp` key is consumed by the scope, so the probe's wire path is
 *  `/surface/surfaceApp/identity/info` (the key does NOT reappear). */
export function surfaceAppClient() {
  return adminEntryLazy().clients.surfaceApp;
}

/** The (cached) admin transport. The admin socket is drishti's control
 *  plane — the one global, always-open connection — so surface-app's
 *  `<SurfaceAppProvider>` observes ITS open/close to derive the connection
 *  lifecycle (and pairs it with the `surfaceApp.info` probe to tell a transient
 *  drop from a parent restart). The per-host sockets are per-entity and keep
 *  their own `connection` cell UI; this is distinct from those. */
export function adminSocket() {
  return adminEntryLazy().ws;
}
