/**
 * Per-host session + handler registry — single source of truth for
 * "which hosts this parent server knows about". Owns:
 *
 *   - One `HostSession` per host (via the kolu pool, keyed by
 *     `(host, drvPath, binary)`).
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
import { buildRouter } from "./router";

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
  log: (line: string) => void;
}

export async function buildHostRegistry(
  opts: HostRegistryOptions,
): Promise<HostRegistry> {
  const entries = new Map<string, HostHandle>();
  // In-flight `add()` calls. With async arch-probing, two concurrent
  // adds for the same host both pass the `entries.has` guard and the
  // second `entries.set` orphans the first session. Tracking the
  // in-flight set separately (instead of a null sentinel inside the
  // entries map) keeps `remove`/`getHandler`/`snapshot` from having to
  // know that a "host exists" can mean "session being spawned".
  const adding = new Set<string>();
  const wsConnectionsByHost = new Map<string, Set<WsConn>>();

  const buildEntry = async (host: string): Promise<HostHandle> => {
    const drvPath = await opts.resolveDrvPath(host);
    const session = getHostSession<typeof surface.contract>({
      host,
      drvPath,
      binary: "drishti-agent",
    });
    const { router } = buildRouter({ session });
    // biome-ignore lint/suspicious/noExplicitAny: implementSurface's Lazy<Router> spread isn't accepted by oRPC's Router<any, T> input type; runtime shape is valid.
    const handler = new RPCHandler(router as any);
    return { session, handler };
  };

  // Parallel initial seeding — per-host arch probes are independent, so
  // a single user dialing into five hosts shouldn't pay the round-trip
  // serially. `Promise.all` propagates the first failure (Bun's default);
  // a failing probe at boot is a misconfiguration we want loud and early.
  const seeded = await Promise.all(
    opts.initialHosts.map(
      async (host): Promise<readonly [string, HostHandle]> => [
        host,
        await buildEntry(host),
      ],
    ),
  );
  for (const [host, handle] of seeded) entries.set(host, handle);

  return {
    has: (host) => entries.has(host) || adding.has(host),
    snapshot: () => {
      const out = new Map<string, HostEntry>();
      for (const host of entries.keys()) out.set(host, { host });
      return out;
    },
    getHandler: (host) => entries.get(host)?.handler,

    async add(host) {
      if (entries.has(host) || adding.has(host)) {
        throw new Error("host already exists");
      }
      adding.add(host);
      const handle = await buildEntry(host).finally(() => adding.delete(host));
      entries.set(host, handle);
      await saveHosts(opts.hostsFile, [...entries.keys()]);
      opts.log(`added host: ${host} (total ${entries.size})`);
    },

    async remove(host) {
      // If add() is in-flight for this host, remove() would be a no-op
      // (entry not yet in `entries`) — but add() would complete after,
      // leaving a live session that the user already removed. Throw
      // instead so the caller can surface a "try again" error.
      if (adding.has(host)) throw new Error("host add in progress, try again");
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
      opts.log(`removed host: ${host} (total ${entries.size})`);
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
