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
import { surfaceClient } from "@kolu/surface/solid";
import { WebSocket as PartySocket } from "partysocket";
import { ADMIN_HOST_SENTINEL, adminSurface } from "../common/admin-surface";
import { surface } from "../common/surface";

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
  const client = surfaceClient(
    adminSurface,
    websocketLink<typeof adminSurface.contract>(ws as unknown as WebSocket),
  );
  return { ws, client };
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

/** Get the (cached) admin surface client. Lazy — opens the admin WS on
 *  first call. */
export function adminClient() {
  if (adminEntry === undefined) adminEntry = buildAdminSurface();
  return adminEntry.client;
}

