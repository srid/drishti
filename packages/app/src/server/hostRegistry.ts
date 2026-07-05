/**
 * Per-host session + handler registry — single source of truth for
 * "which hosts this parent server knows about". Owns:
 *
 *   - One `Session` per host (`makeSession` over an `sshConnector`
 *     transport plug, keyed by host).
 *   - One `RPCHandler` per host (built from `buildRouter({session})`).
 *   - The set of open browser WebSockets per host (for eviction on
 *     remove — partysocket auto-reconnects, so we close on the server
 *     side to make a removal stick).
 *   - The on-disk persistence of the host set (delegated to
 *     `hostsStore.ts`).
 *
 * The admin router's `readAll` projects from this registry via
 * `snapshot()` — there is no shadow data store; admin and registry
 * cannot diverge by construction.
 *
 * Insertion order is preserved (JavaScript `Map` semantics) so the
 * tab strip displays hosts in the order the user added them.
 *
 * R7 keystone (kolu #1505): the keyed `Map<host, {session, handler}>`
 * mechanism + its add/remove/reconnect/recheckAll + per-host socket
 * eviction lifecycle now live in `@kolu/surface-nix-host`'s
 * `buildHostRegistry` — lifted verbatim-in-shape from this very file, so
 * pulam-web's terminal-awareness server can share it. drishti keeps a
 * THIN wrapper here: it owns only the app-specific knowledge the shared
 * registry deliberately doesn't hold — how a host becomes a `{ session,
 * handler }` (`buildEntry`: `makeSession`/`sshConnector` + `buildRouter` +
 * `new RPCHandler`), where the host set persists (`saveHosts`), and the
 * admin-surface wire-shape projection (`snapshot()`). The wrapper's async
 * signature and `resolveDrvPath`/`hostsFile` options are preserved so
 * `main.ts` and `admin-router.ts` call it exactly as before.
 */

import { RPCHandler } from "@orpc/server/ws";
import {
  type AgentClient,
  buildHostRegistry as buildSharedHostRegistry,
  type FleetControls,
  type HostRegistry as SharedHostRegistry,
  makeSession,
  type Session,
  sshConnector,
} from "@kolu/surface-nix-host";
import type { WebSocket as WsConn } from "ws";
import type { HostEntry } from "../common/admin-surface";
import type { surface } from "drishti-common";
import { saveHosts } from "./hostsStore";
import { makeLogger } from "./log";
import { buildRouter } from "./router";

// Registry lifecycle events (host added/removed) get their own tag, like
// every other subsystem — so they can be filtered out of the combined
// stderr stream without the caller threading a logger in.
const log = makeLogger("registry");

// The parent's connect-handshake watchdog budget, passed explicitly to
// every session. Must stay well under the browser socket's own deadline
// (`wire.ts` `connectionTimeout: 60_000`) so the parent gives up on a
// wedged connect and cycles the ssh child *before* the browser drops the
// user. kolu defaults `connectTimeoutMs` to this same value; we state it
// at the call site so the budget is visible here, beside the constraint
// it answers to, rather than buried in the library's default.
const CONNECT_TIMEOUT_MS = 30_000;

// The shared registry stores a generic handler `H`; drishti's is the
// oRPC ws `RPCHandler`. Pin `H` to that here so `getHandler` hands back a
// concrete handler at the upgrade dispatch in `main.ts`.
// biome-ignore lint/suspicious/noExplicitAny: matches existing router-handler cast (see implementSurface fragment shape).
type DrishtiHandler = RPCHandler<any>;

export interface HostRegistry {
  has(host: string): boolean;
  /** Project the live host set into the admin surface's wire shape.
   *  Called by the admin router's `readAll` on every new subscriber. */
  snapshot(): Map<string, HostEntry>;
  getHandler(host: string): DrishtiHandler | undefined;
  /** Spawn a new host session and persist the host set. Throws if the
   *  host already exists. The admin router publishes the per-key channel
   *  update AFTER this resolves, so a new subscriber never sees a host
   *  whose handler isn't ready. */
  add(host: string): Promise<void>;
  /** Close any open browser WSes for the host, destroy the session, and
   *  persist the host set. Same ordering guarantee as `add`: the admin
   *  router publishes the removal AFTER this resolves. */
  remove(host: string): Promise<void>;
  /** Re-arm a host whose session gave up (`connection === "failed"`).
   *  Resets the session's failure gate and respawns; the bridge picks up
   *  the fresh client. No-op if the host isn't registered — the session,
   *  not the host set, is what changes, so callers don't await it and no
   *  persistence happens. */
  reconnect(host: string): void;
  /** Force a fresh link probe on *every* host — the fleet-wide companion
   *  to the wake / network-change signals (`wakeMonitor`, the browser's
   *  `online`/`visibilitychange`). Unlike `reconnect`, this cycles even a
   *  `connected` session, because after a laptop sleep a "live" ssh child
   *  is often holding a socket the far end already dropped (kolu's
   *  `recheck()` — see there). Per-session no-ops mean an already-healthy
   *  host just blips through one fast reconnect; idle (unpinned) sessions
   *  are skipped. */
  recheckAll(): void;
  registerConnection(host: string, ws: WsConn): void;
  unregisterConnection(host: string, ws: WsConn): void;
  /** Destroy every host's session — called from the server's `shutdown()`.
   *  Replaces the deleted free-standing `destroyAllSessions()`: sessions are
   *  no longer pooled, so teardown runs through the registry that owns them. */
  destroyAll(): void;
}

export interface HostRegistryOptions {
  initialHosts: readonly string[];
  /** Resolve a host string to its agent `.drv` path. The registry has
   *  no business knowing how the answer was reached (arch probe, map
   *  lookup, a static value for localhost-only dev) — it just awaits
   *  the resolved path per host. */
  resolveDrvPath: (host: string) => Promise<string>;
  hostsFile: string;
}

export async function buildHostRegistry(
  opts: HostRegistryOptions,
): Promise<HostRegistry> {
  // The shared registry owns the keyed map + its full lifecycle. drishti
  // supplies only `buildEntry` (how a host becomes a session + handler)
  // and `persist` (where the host set lands on disk). Both stay SYNC for
  // `buildEntry`: `makeSession` defers the spawn into the session's own
  // reconnect machinery, so a host unreachable at boot surfaces as a
  // per-host `failed` connection state — never a throw that takes the
  // whole registry (and with it the parent's HTTP port, never bound until
  // this resolves) down.
  const shared: SharedHostRegistry<
    Session<AgentClient<typeof surface.contract>>,
    DrishtiHandler
  > &
    FleetControls = buildSharedHostRegistry({
    initialHosts: opts.initialHosts,
    buildEntry: (host) => {
      // `makeSession` over an `sshConnector` transport plug (kolu S9/S10 —
      // the deleted `getHostSession` is now this composition). The connector
      // owns everything transport-specific (resolve .drv per dial, nix copy,
      // spawn ssh, wire stdio to a typed client); `makeSession` owns the
      // durable lifecycle (pin/ref-count, backoff, give-up, watchdogs,
      // reconnect/recheck, the connection-state cell). The agent .drv is
      // resolved LAZILY inside the connector's dial (not awaited here): a host
      // unreachable at probe time makes the resolver reject, which the loop
      // treats as an ordinary connection failure (disconnected → backoff →
      // failed, re-armable via Reconnect) — so it can't throw out of here
      // before the session exists, and one unreachable initial host can't
      // crash the whole server at boot.
      const session = makeSession<AgentClient<typeof surface.contract>>({
        connectOnce: sshConnector<typeof surface.contract>({
          host,
          binary: "drishti-agent",
          resolveDrvPath: () => opts.resolveDrvPath(host),
        }),
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        label: `host:${host}`,
      });
      const { router } = buildRouter({ host, session });
      // biome-ignore lint/suspicious/noExplicitAny: implementSurface's Lazy<Router> spread isn't accepted by oRPC's Router<any, T> input type; runtime shape is valid.
      const handler = new RPCHandler(router as any);
      return { session, handler };
    },
    // Fleet verbs (`reconnect(host)` / `recheckAll()`) exist on the returned
    // registry ONLY when `controls` is supplied (kolu S2) — they're how the
    // registry enacts a re-arm / link-recheck on each session. The `Session`
    // that `makeSession` returns carries universal `reconnect()` / `recheck()`
    // methods, so these thunks typecheck directly.
    controls: {
      reconnect: (s) => s.reconnect(),
      recheck: (s) => s.recheck(),
    },
    // Persist after every add/remove, awaited before the call resolves
    // (the shared registry guarantees the ordering) — so the admin
    // router's announce never races ahead of the on-disk store.
    persist: (hosts) => saveHosts(opts.hostsFile, hosts),
    log: (line) => log(line),
  });

  return {
    has: (host) => shared.has(host),
    // The admin surface's wire shape is `Map<host, { host }>`; the shared
    // registry exposes only the host strings (`hosts()`), so project them
    // back into the keyed map here. Same projection the old in-file
    // registry did — admin and registry still can't diverge, because both
    // read the one `entries` map inside the shared registry.
    snapshot: () => {
      const out = new Map<string, HostEntry>();
      for (const host of shared.hosts()) out.set(host, { host });
      return out;
    },
    getHandler: (host) => shared.getHandler(host),
    add: (host) => shared.add(host),
    remove: (host) => shared.remove(host),
    reconnect: (host) => shared.reconnect(host),
    recheckAll: () => shared.recheckAll(),
    // `WsConn` (ws's WebSocket) structurally satisfies the shared
    // registry's `ClosableSocket` (`close(code, reason?)`), so it passes
    // through without a cast.
    registerConnection: (host, ws) => shared.registerConnection(host, ws),
    unregisterConnection: (host, ws) => shared.unregisterConnection(host, ws),
    destroyAll: () => shared.destroyAll(),
  };
}
