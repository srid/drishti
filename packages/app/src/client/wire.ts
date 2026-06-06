/**
 * Client-side surface bundle — one WebSocket per host.
 *
 * Each host gets its own `surfaceClient` over its own `PartySocket`;
 * the admin surface (host set) gets one more at the reserved sentinel.
 * The cache keeps the PartySocket stable across Solid component
 * remounts so a tab switch doesn't tear down the connection — only the
 * subscriptions inside it.
 *
 * `disposeHostSurface(host)` closes a host's socket when it's removed
 * from the admin collection so the cache doesn't leak.
 */

import { websocketLink } from "@kolu/surface/links/websocket";
import { surfaceClient, surfaceClients } from "@kolu/surface/solid";
import { WebSocket as PartySocket } from "partysocket";
import {
  ADMIN_HOST_SENTINEL,
  adminContract,
  adminSurfaces,
} from "../common/admin-surface";
import { surface } from "drishti-common";

function wsUrlFor(host: string): string {
  const params = new URLSearchParams({ host });
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc/ws?${params.toString()}`;
}

// `partysocket`'s `WebSocket` export is `ReconnectingWebSocket`. Cold
// start can take 30+ seconds while the parent provisions the agent via
// `nix copy`, so the connect deadline is bumped well past partysocket's
// 4s default — without this, the socket flaps repeatedly during the
// first connect.
function makeSocket(host: string): PartySocket {
  return new PartySocket(wsUrlFor(host), undefined, {
    connectionTimeout: 60_000,
    minReconnectionDelay: 2_000,
    maxReconnectionDelay: 15_000,
  });
}

type HostClient = ReturnType<typeof buildHostSurface>;
type AdminClient = ReturnType<typeof buildAdminSurface>;

function buildHostSurface(host: string) {
  const ws = makeSocket(host);
  const client = surfaceClient(
    surface,
    websocketLink<typeof surface.contract>(ws as unknown as WebSocket),
  );
  return { ws, client };
}

function buildAdminSurface() {
  const ws = makeSocket(ADMIN_HOST_SENTINEL);
  // The admin transport multiplexes TWO sibling surfaces (kolu#1197/#1201):
  // drishti's own `admin` surface (the host set + procedures) and surface-app's
  // complete surface (`buildInfo` + the `identity.info` probe). `surfaceClients`
  // splits the one link into a per-key client bundle; each client's `.rpc` is
  // the SCOPED slice (`{ surface: link.surface[key] }`), so its primitives
  // resolve at `/surface/<key>/<prim>/<verb>`.
  const link = websocketLink<typeof adminContract>(ws as unknown as WebSocket);
  const clients = surfaceClients(link, adminSurfaces);
  return { ws, link, clients };
}

const hostCache = new Map<string, HostClient>();

/** Get the (cached) surface client for `host`. The first call opens
 *  the PartySocket; subsequent calls return the same instance so a tab
 *  remount preserves the live connection. */
export function surfaceForHost(host: string) {
  let entry = hostCache.get(host);
  if (entry === undefined) {
    entry = buildHostSurface(host);
    hostCache.set(host, entry);
  }
  return entry.client;
}

/** Close the host's socket and drop the cached client. Call when the
 *  admin collection signals the host was removed — otherwise the
 *  PartySocket keeps trying to reconnect into a server slot that no
 *  longer exists. */
export function disposeHostSurface(host: string): void {
  const entry = hostCache.get(host);
  if (entry === undefined) return;
  hostCache.delete(host);
  try {
    entry.ws.close();
  } catch {
    /* best-effort */
  }
}

let adminEntry: AdminClient | undefined;

function adminEntryLazy(): AdminClient {
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

/** The admin surface's PROCEDURE namespace, typed off the full combined link.
 *  `adminRpc().hosts.add(...)` / `.remove(...)` / `.reconnect(...)` /
 *  `.recheck(...)` resolve at `/surface/admin/hosts/<verb>`. Procedure calls go
 *  through the full typed link (not the per-key scoped client, whose `.rpc` is
 *  `unknown`) — mirroring kolu, where raw/surface procedures resolve off the
 *  full combined link rather than a scoped slice. */
export function adminRpc() {
  return adminEntryLazy().link.surface.admin;
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

