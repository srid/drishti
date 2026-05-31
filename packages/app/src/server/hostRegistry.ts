/**
 * Per-host session + handler registry — single source of truth for
 * "which hosts this parent server knows about". Owns:
 *
 *   - One `HostSession` per host (via the kolu pool, keyed by
 *     `(host, binary)`).
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
 */

import { RPCHandler } from "@orpc/server/ws";
import {
  getHostSession,
  type HostSession,
} from "@kolu/surface-nix-host";
import type { WebSocket as WsConn } from "ws";
import type { HostEntry } from "../common/admin-surface";
import type { surface } from "../common/surface";
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

interface HostHandle {
  session: HostSession<typeof surface.contract>;
  // biome-ignore lint/suspicious/noExplicitAny: matches existing router-handler cast (see implementSurface fragment shape).
  handler: RPCHandler<any>;
}

export interface HostRegistry {
  has(host: string): boolean;
  /** Project the live host set into the admin surface's wire shape.
   *  Called by the admin router's `readAll` on every new subscriber. */
  snapshot(): Map<string, HostEntry>;
  // biome-ignore lint/suspicious/noExplicitAny: matches existing router-handler cast.
  getHandler(host: string): RPCHandler<any> | undefined;
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
  registerConnection(host: string, ws: WsConn): void;
  unregisterConnection(host: string, ws: WsConn): void;
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
  const entries = new Map<string, HostHandle>();
  const wsConnectionsByHost = new Map<string, Set<WsConn>>();

  const buildEntry = (host: string): HostHandle => {
    const session = getHostSession<typeof surface.contract>({
      host,
      // Resolve the agent .drv lazily, inside the session's spawn cycle,
      // rather than awaiting the arch probe here. A host that's
      // unreachable at probe time makes the resolver reject, which the
      // session treats as an ordinary connection failure (disconnected →
      // backoff → failed, re-armable via Reconnect) — so it can't throw
      // out of here before the session exists. That's what keeps one
      // unreachable initial host from crashing the whole server at boot.
      resolveDrvPath: () => opts.resolveDrvPath(host),
      binary: "drishti-agent",
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
    });
    const { router } = buildRouter({ host, session });
    // biome-ignore lint/suspicious/noExplicitAny: implementSurface's Lazy<Router> spread isn't accepted by oRPC's Router<any, T> input type; runtime shape is valid.
    const handler = new RPCHandler(router as any);
    return { session, handler };
  };

  // Seed every configured host synchronously. `buildEntry` no longer
  // awaits anything — the per-host arch probe it used to run up front now
  // lives inside the session's spawn cycle — so seeding can't reject, and
  // a host that's unreachable at boot surfaces as a per-host `failed`
  // connection state instead of taking the whole registry (and with it
  // the parent's HTTP port, never bound until this resolves) down. The
  // old code awaited `Promise.all`, whose first rejection propagated to
  // `main()`'s top-level catch and exited the process before `serve()`.
  for (const host of opts.initialHosts) entries.set(host, buildEntry(host));

  return {
    has: (host) => entries.has(host),
    snapshot: () => {
      const out = new Map<string, HostEntry>();
      for (const host of entries.keys()) out.set(host, { host });
      return out;
    },
    getHandler: (host) => entries.get(host)?.handler,

    async add(host) {
      if (entries.has(host)) {
        throw new Error("host already exists");
      }
      entries.set(host, buildEntry(host));
      await saveHosts(opts.hostsFile, [...entries.keys()]);
      log(`added host: ${host} (total ${entries.size})`);
    },

    async remove(host) {
      const entry = entries.get(host);
      if (entry === undefined) return;
      const sockets = wsConnectionsByHost.get(host);
      if (sockets !== undefined) {
        for (const ws of sockets) {
          try {
            ws.close(1000, "host removed");
          } catch {
            /* best-effort */
          }
        }
        wsConnectionsByHost.delete(host);
      }
      entry.session.destroy();
      entries.delete(host);
      await saveHosts(opts.hostsFile, [...entries.keys()]);
      log(`removed host: ${host} (total ${entries.size})`);
    },

    reconnect(host) {
      entries.get(host)?.session.reconnect();
    },

    registerConnection(host, ws) {
      let set = wsConnectionsByHost.get(host);
      if (set === undefined) {
        set = new Set();
        wsConnectionsByHost.set(host, set);
      }
      set.add(ws);
    },

    unregisterConnection(host, ws) {
      wsConnectionsByHost.get(host)?.delete(ws);
    },
  };
}
