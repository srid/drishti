/**
 * The warm host SESSION pool — single source of truth for "which hosts
 * this parent server knows about" and their `Session` lifecycle
 * (spawn/reconnect/recheck/destroy).
 *
 * This file USED to also own a per-host oRPC `RPCHandler` + the browser-WS
 * eviction bookkeeping a `?host=` upgrade dispatcher needed (kolu #1505's
 * `buildHostRegistry`, admin-surface's `hosts` collection projecting off
 * it). Both are DELETED: every host's traffic now rides the ONE admin
 * transport, folded through `@kolu/surface-map`'s keyed host MAP
 * (`hostMap.ts`, served by `admin-router.ts`'s `serveHostMap`) — there is
 * no more `?host=` socket to dispatch, no per-host `RPCHandler` to build,
 * and no per-host browser-WS set to close on removal (removing a host now
 * ends that key's live subs with a typed end, over the ONE shared socket,
 * before the session is destroyed — `serveSurfaceMap`'s own guarantee).
 *
 * What's left is exactly `@kolu/surface-remote`'s `buildRemotePool` (S1/S2,
 * renamed upstream from `buildHostRegistry`) plus the ONE piece of
 * app-specific knowledge it deliberately doesn't hold: how a host becomes a
 * `Session` (`makeSession`/`sshConnector`), and where the host set persists
 * (`hostsStore.ts`). The returned pool is handed AS-IS to `serveHostMap`
 * (`admin-router.ts`) — the `MapRegistry` bridge, membership `entries`
 * collection, and `EntryStatus` projection all live there now, not here.
 */

import {
  type AgentClient,
  buildRemotePool,
  makeSession,
  type PoolControls,
  type RemotePool,
  type Session,
  sshConnector,
  type SshProv,
} from "@kolu/surface-remote";
import type { surface } from "drishti-common";
import { saveHosts } from "./hostsStore";
import { makeLogger } from "./log";

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

export type HostSession = Session<AgentClient<typeof surface.contract>, SshProv>;

/** The pool `serveHostMap` consumes directly (`MembershipPool` is a slice
 *  of this same `RemotePool` shape) — no drishti-local wrapper interface
 *  left to keep in sync with it. */
export type HostPool = RemotePool<HostSession, undefined> & PoolControls;

export interface HostPoolOptions {
  initialHosts: readonly string[];
  /** Resolve a host string to its agent `.drv` path. The pool has no
   *  business knowing how the answer was reached (arch probe, map
   *  lookup, a static value for localhost-only dev) — it just awaits
   *  the resolved path per host. */
  resolveDrvPath: (host: string) => Promise<string>;
  hostsFile: string;
}

/** Build the warm host session pool. Sync: `makeSession` defers the spawn
 *  into the session's own reconnect machinery, so a host unreachable at
 *  boot surfaces as a per-host `failed` connection state — never a throw
 *  that takes the whole pool (and with it the parent's HTTP port, never
 *  bound until this returns) down. */
export function buildHostPool(opts: HostPoolOptions): HostPool {
  return buildRemotePool<HostSession, undefined>({
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
      const session = makeSession<AgentClient<typeof surface.contract>, SshProv>({
        connectOnce: sshConnector<typeof surface.contract>({
          host,
          binary: "drishti-agent",
          resolveDrvPath: () => opts.resolveDrvPath(host),
        }),
        // `sshConnector` PROVISIONS (nix-copies the agent closure before
        // dialing), so its true opening phase is the connector's FIRST
        // provisioning phase, "probing" (kolu W6 widened `SshProv` to
        // `probing → copying → building`) — every drishti host, including
        // "localhost", dials through it (kolu#1716/#1808: the connector's own
        // opening phase, never a LOCAL-set one).
        initialConnection: "probing",
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        label: `host:${host}`,
      });
      // No per-host oRPC handler: `admin-router.ts`'s `serveHostMap` builds
      // this host's `directLink` on demand (`linkFor`) from its own
      // `buildRouter({host, session})` call — the map's key-folded single
      // link replaces the `?host=` handler-per-socket dispatch this used to
      // carry.
      return { session, handler: undefined };
    },
    // Fleet verbs (`reconnect(host)` / `recheckAll()`) exist on the returned
    // pool ONLY when `controls` is supplied (kolu S2) — they're how the
    // pool enacts a re-arm / link-recheck on each session. The `Session`
    // that `makeSession` returns carries universal `reconnect()` / `recheck()`
    // methods, so these thunks typecheck directly.
    controls: {
      reconnect: (s) => s.reconnect(),
      recheck: (s) => s.recheck(),
    },
    // Persist after every add/remove, awaited before the call resolves
    // (the pool guarantees the ordering) — so the admin router's `entries`
    // republish never races ahead of the on-disk store.
    persist: (hosts) => saveHosts(opts.hostsFile, hosts),
    log: (line) => log(line),
  });
}
