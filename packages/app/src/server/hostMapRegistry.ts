/**
 * Bridge `HostPool` (`hostRegistry.ts`, a `@kolu/surface-remote`
 * `RemotePool`) to `@kolu/surface-map/server`'s `MapRegistry<string>` — the
 * seam `serveSurfaceMap` consumes directly.
 *
 * This is `@kolu/surface-remote`'s OWN `serveHostMap` adapter, hand-adapted
 * rather than imported: `serveHostMap` requires `S extends ClockableSession`
 * (`session.clockOffset(): number | null`), which kolu's padi sessions
 * satisfy via an admit-handshake round-trip (`measureClockOffset` against a
 * `control.core.clockNow` procedure). drishti's `browserSurface` has no such
 * primitive, and — unlike kolu, which reprojects host-stamped TERMINAL
 * timestamps through `entry.clock.toLocal(clockOffset)` — drishti's UI
 * stamps every metric sample with the PARENT's OWN clock
 * (`router.ts`'s `captureSample(Date.now(), system)`), never a
 * remote-host-stamped one. So `clockOffset` is wire-shape-REQUIRED by
 * `EntryStatus.connected` but has no real fact behind it here: `0` is
 * honest (there is no unmeasured true value being hidden), not an invented
 * fallback. Adding a genuine `clockNow` round-trip is future work if a
 * host-stamped timestamp consumer ever appears — see
 * `@kolu/surface-remote`'s `measureClockOffset`.
 *
 * The `EntryConnectionState`/`SessionState` projection below otherwise
 * mirrors `serveHostMap`'s `projectState` exactly (copying/connecting →
 * warming, connected → connected, disconnected/failed → failed(reason)).
 * The juspay/kolu#1716 "non-provisioning session can't legitimately reach
 * `copying`" belt is skipped: every drishti host — including `localhost` —
 * dials through `sshConnector` (`hostRegistry.ts`), so there is no
 * non-provisioning session arm here for it to guard.
 */

import type { MapRegistry } from "@kolu/surface-map/server";
import type { EntryConnectionState } from "@kolu/surface-map/server";
import type { RemotePool } from "@kolu/surface-remote";
import type { SessionState } from "@kolu/surface-remote";
import type { HostSession } from "./hostRegistry";

function projectState(s: SessionState | undefined): EntryConnectionState {
  if (s === undefined) return { kind: "connecting" };
  switch (s.connection) {
    case "copying":
      return { kind: "copying" };
    case "connecting":
      return { kind: "connecting" };
    case "connected":
      return { kind: "connected", clockOffset: 0 };
    case "disconnected":
      return { kind: "disconnected", reason: s.lastError };
    case "failed":
      return { kind: "failed", reason: s.lastError };
  }
}

export interface HostMapRegistry extends MapRegistry<string> {
  /** Tear down the fused per-session `onState` subs, the cached per-host
   *  links, and the pool membership sub. Called from `main.ts`'s
   *  `shutdown()` alongside `pool.destroyAll()`. */
  dispose(): void;
}

export interface HostMapRegistryOptions {
  /** Build the re-served entry-surface LINK for one host — a `directLink`
   *  over that host's own `buildRouter({host, session}).router`. Called
   *  once per host; the result is cached here and evicted on removal, so a
   *  bridge is never built twice for a host. */
  linkFor: (host: string, session: HostSession) => unknown;
}

/** Build the `MapRegistry<string>` `serveSurfaceMap` consumes, fused off
 *  `pool`'s membership + each member session's own `onState` — so `entries`
 *  republishes on BOTH a membership change AND a per-session STATUS
 *  transition (warming → connected → failed), the latter not being a
 *  membership event but one the UI must still see. */
export function buildHostMapRegistry(
  pool: RemotePool<HostSession, undefined>,
  opts: HostMapRegistryOptions,
): HostMapRegistry {
  const latestState = new Map<string, SessionState>();
  const stateSubs = new Map<string, () => void>();
  const links = new Map<string, unknown>();
  const changeListeners = new Set<() => void>();

  const fire = (): void => {
    for (const l of [...changeListeners]) l();
  };

  const attach = (host: string): void => {
    if (stateSubs.has(host)) return;
    const session = pool.getSession(host);
    if (session === undefined) return;
    const off = session.onState((s) => {
      latestState.set(host, s);
      fire();
    });
    stateSubs.set(host, off);
  };
  const detach = (host: string): void => {
    stateSubs.get(host)?.();
    stateSubs.delete(host);
    latestState.delete(host);
    links.delete(host);
  };
  const reconcile = (): void => {
    const current = new Set(pool.hosts());
    for (const host of current) attach(host);
    for (const host of [...stateSubs.keys()])
      if (!current.has(host)) detach(host);
  };
  reconcile();

  // `pool.subscribe` fires only after `hosts()`/`has()` reflect the change
  // (the ordering `MapRegistry.subscribe`'s own contract depends on), so the
  // fused signal is never ahead of the snapshot the republish reads.
  const offMembership = pool.subscribe(() => {
    reconcile();
    fire();
  });

  const linkFor = (host: string, session: HostSession): unknown => {
    let link = links.get(host);
    if (link === undefined) {
      link = opts.linkFor(host, session);
      links.set(host, link);
    }
    return link;
  };

  return {
    members: () => pool.hosts(),
    has: (host) => pool.has(host),
    subscribe(onChange) {
      changeListeners.add(onChange);
      return () => {
        changeListeners.delete(onChange);
      };
    },
    resolve(host) {
      const session = pool.getSession(host);
      if (session === undefined) return { failed: `unknown host: ${host}` };
      return {
        link: linkFor(host, session),
        state: projectState(latestState.get(host)),
      };
    },
    dispose() {
      offMembership();
      for (const off of stateSubs.values()) off();
      stateSubs.clear();
      latestState.clear();
      links.clear();
      changeListeners.clear();
    },
  };
}
