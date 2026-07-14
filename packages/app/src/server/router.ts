/**
 * Parent-side router — bridges browser ↔ remote agent.
 *
 * The browser subscribes to the same `surface` as the agent serves. The
 * parent doesn't re-define a different surface; it implements the agent
 * surface locally by *forwarding* every read to the remote stdio client.
 * On a fresh subscriber, the parent:
 *
 *   1. Synchronously yields the parent's connection-state-aware
 *      `system` snapshot (state = "copying" / "connecting" / etc.).
 *   2. Once the agent's link is up, mirrors the agent's `system` and
 *      `processes` updates into the parent's local store/collection.
 *   3. Per-key process upserts/removes from the agent flow through to
 *      the framework's channels and on to the browser.
 *
 * The surface is strictly read-only — it carries no procedures, so the
 * parent only ever mirrors agent data inward; it never forwards a
 * mutation back to the host.
 *
 * R7 keystone (kolu #1505): the reconnect-mirror loop that used to live
 * here as `bridgeAgentToParent` is now `@kolu/surface-remote`'s
 * `pumpRemoteSurface` — lifted verbatim-in-shape from this file so
 * pulam-web's terminal-awareness server can share it. drishti keeps only
 * the surface-specific knowledge the pump deliberately doesn't hold: the
 * per-spawn sink (`makeSink`) that folds the agent's `system` / `cpuCores`
 * / `networkInterfaces` / `processesSnapshot` frames into the parent's
 * local surface, and the `liveProcedures` holder the `kill` forward reads.
 *
 * The router this file builds is now the ENTRY surface `@kolu/surface-map`
 * serves N times — `admin-router.ts`'s `serveHostMap` calls `buildRouter`
 * once per pool member and hands `directLink(router)` to the map as that
 * host's `linkFor`, replacing the `RPCHandler`-per-`?host=`-socket dispatch
 * this file used to feed directly.
 */

import {
  type CellStore,
  type Channel,
  extendSurface,
  implementSurface,
  inMemoryChannel,
  inMemoryStore,
} from "@kolu/surface/server";
import { type ProcedureForwarders } from "@kolu/surface/mirror";
import {
  type AgentClient,
  pumpRemoteSurface,
  seedConnectionCell,
  type Session,
  type SshProv,
} from "@kolu/surface-remote";
import {
  type ConnectionInfo,
  historySurface,
  mirroredAgentSurface,
} from "drishti-common/browser";
import {
  type CoreId,
  type CpuCore,
  DEFAULT_SYSTEM,
  type IfaceName,
  type MetricHistoryMsg,
  type MetricSample,
  type NetInterface,
  type Pid,
  type Process,
  type SystemInfo,
  surface,
} from "drishti-common";
import { type Alerts, NO_ALERTS } from "drishti-common/alerts";
import {
  captureSample,
  HISTORY_RETENTION_MS,
  pushSample,
} from "../common/history";
import { type Logger, makeLogger } from "./log";

export interface BuildRouterOptions {
  /** The host this router bridges — used only to tag the bridge's log
   *  lines (`bridge:${host}`). The `Session` keeps its `host` private,
   *  so the registry (which has it) passes it in explicitly. */
  host: string;
  session: Session<AgentClient<typeof surface.contract>, SshProv>;
}

/** Build the parent's oRPC router. The session's connection state
 *  drives the `system.state` field exposed to the browser; agent data
 *  flows through once the link is live. */
export function buildRouter(opts: BuildRouterOptions) {
  const session = opts.session;
  // Per-host bridge logger. One `buildRouter` runs per host, so a tag
  // built from `host` here gives every bridge line a host discriminator —
  // without it, the N concurrent per-host bridge loops all wrote a flat
  // `[bridge]` and interleaved into one unattributable stream.
  const log = makeLogger(`bridge:${opts.host}`);
  const systemStore: CellStore<SystemInfo> = inMemoryStore({
    ...DEFAULT_SYSTEM,
  });
  // The parent MIRRORS the agent's `alerts` cell (the agent is the sole
  // producer — it folds the threshold+hysteresis derivation via the reactor).
  // A plain local store the pump sink writes each agent `alerts` frame into,
  // re-served to the browser exactly like `system`. Seeds gate-closed
  // (`NO_ALERTS`) until the first agent frame lands.
  const alertsStore: CellStore<Alerts> = inMemoryStore({ ...NO_ALERTS });
  // The seeded, gate-closed connection cell — the shared `seedConnectionCell()`,
  // not a hand-rolled store. Written by `pumpRemoteSurface` off `session.onState`
  // (the `connection` option below), which owns the subscription + teardown.
  const connection = seedConnectionCell();
  const processCache = new Map<Pid, Process>();
  const coreCache = new Map<CoreId, CpuCore>();
  const netCache = new Map<IfaceName, NetInterface>();
  // No browser snapshot bus: the whole-process-set protocol is the `processes`
  // collection's `deltas` verb now. The pump mirrors the agent's process frames
  // into `processCache` through the collection sink, and the framework re-serves
  // that collection's coalesced deltas to the browser (SR5 — one protocol).
  // Parent-owned metric-history ring. Sampled once per agent poll tick (see
  // `recordSample`), bounded to the widest selectable window, and held for
  // the life of this session — independent of any browser. A new browser
  // subscriber is re-seeded from `historyRing` (full snapshot) then fed
  // per-tick deltas via `historyBus`, so reloads and tab switches replay the
  // whole history. Reassigned (not mutated) by `pushSample`; the stream
  // source reads the current binding on subscribe.
  let historyRing: MetricSample[] = [];
  const historyBus: Channel<MetricHistoryMsg> =
    inMemoryChannel<MetricHistoryMsg>();

  // R7 (kolu #1505): the browser's `process.kill` is forwarded to the agent
  // through the MIRROR's procedure stub — the first forwarded procedure on a
  // mirrored surface. The mirror is re-issued per spawn (stdio doesn't recover
  // mid-stream), so the live stub set lives in this holder: the pump sets it
  // on each connect and clears it when the link dies. A kill with no live agent
  // reports `{ ok: false }` rather than silently no-op'ing.
  const liveProcedures: {
    current: ProcedureForwarders<typeof surface.spec> | null;
  } = { current: null };

  // Implements the MIRRORED surface (base + the get-only `connection` cell). The
  // base primitives are forwarded/folded from the agent; `connection` is the
  // seeded local store the session pump writes — the agent's surface stays
  // connection-free.
  const runtime = implementSurface(mirroredAgentSurface, {
    cells: {
      system: { store: systemStore },
      alerts: { store: alertsStore },
      connection,
    },
    collections: {
      processes: {
        readAll: () => processCache,
        // The framework's wrapped upsert/remove call these deps first
        // and only then publish through the keyed channels. If we throw
        // here (to "guard against browser writes"), the framework's own
        // bridging path — `ctx.collections.processes.upsert(...)` from
        // `reconcileProcesses` — also throws and the publish never fires.
        // Browser-vs-server isn't a write-vs-read distinction inside the
        // process; it's a wire-protocol distinction (the browser-facing
        // contract simply doesn't expose `upsert` / `remove`). So these
        // deps stay as the single in-process write seam.
        upsert: (key, value) => {
          processCache.set(key, value);
        },
        remove: (key) => {
          processCache.delete(key);
        },
      },
      cpuCores: {
        readAll: () => coreCache,
        upsert: (key, value) => {
          coreCache.set(key, value);
        },
        remove: (key) => {
          coreCache.delete(key);
        },
      },
      networkInterfaces: {
        readAll: () => netCache,
        upsert: (key, value) => {
          netCache.set(key, value);
        },
        remove: (key) => {
          netCache.delete(key);
        },
      },
    },
    // No `streams` on the mirrored surface: `processes` is served to the browser as
    // a `deltas` collection (framework-coalesced, folded from the agent by the pump),
    // and `metricHistory` is a PARENT-LOCAL member composed on via `extendSurface`
    // below (its own `historyRuntime`), not a member of the mirrored agent surface.
    // The browser-facing `kill` is a pure FORWARD: the parent owns no pids, so it
    // relays to the agent through the live mirror's procedure stub (the R7 proof).
    // No live link → an honest `{ ok: false }`, surfaced to the user; a stub call
    // against a just-dropped link rejects and the rejection reaches the browser.
    procedures: {
      process: {
        kill: async ({ input }) => {
          const procs = liveProcedures.current;
          if (!procs) {
            return { ok: false, error: "no live agent connection" };
          }
          return procs.process.kill(input);
        },
      },
    },
  });

  // Compile-time guard for the least-privilege narrowing: the real
  // runtime must satisfy the pump sink's write-only view. Stated here (not
  // only implied by the `makeSink` closure below) so a refactor of that sink
  // can't quietly drop the check — a surface collection rename surfaces as
  // an error on this line.
  const _pumpCtx: FragmentCtx = runtime;
  void _pumpCtx;

  // Sample the metric ring once per agent system tick. Every series reads off
  // the just-arrived `system` snapshot — CPU% is the agent-computed
  // `system.cpuPct` (the single host-CPU mean), so the parent no longer
  // re-averages `coreCache` (which is pumped on a separate leg and could lag
  // the system tick by a frame). `pushSample` evicts points past the retention
  // bound, and the delta goes to every live browser subscriber.
  const recordSample = (system: SystemInfo): void => {
    const sample = captureSample(Date.now(), system);
    historyRing = pushSample(historyRing, sample, HISTORY_RETENTION_MS);
    historyBus.publish({ kind: "delta", sample });
  };

  // ── Bridge remote agent surface → parent's local surface ──────────
  // `pumpRemoteSurface` (R7 keystone) pins the session, then loops over
  // each successive AgentClient the session produces — each time the agent
  // process is respawned (after a transport drop), the pump fetches the new
  // client and re-issues ONE `mirrorRemoteSurface` against the sink built
  // below. The framework's `ClientRetryPlugin` is NOT load-bearing here:
  // stdio links don't recover mid-stream (the underlying streams die with
  // the process), so the only reliable recovery is to re-mirror on the
  // *new* client. The pump's outer loop is what implements "reconnect →
  // state reconciles, no ghosts"; drishti supplies only the per-spawn sink.
  void pumpRemoteSurface({
    source: surface,
    session,
    // Build the mirror sink for ONE freshly-spawned client. Called once per
    // (re)spawn, so the per-client state below resets naturally each
    // reconnect: the agent leads every (re)connect with a fresh `system`
    // snapshot, so the first-frame handshake marker and the frame counter
    // re-arm with the client. `seq` labels successive spawns (`#1`, `#2`, …)
    // so the otherwise-identical per-reconnect log lines trace to a specific
    // spawn — if the mirror against `#2` never yields a `system` frame while
    // the agent logged `serving surface over stdio`, the handoff (not the
    // remote) is where a stuck reconnect lives.
    makeSink: ({ seq }) => {
      let firstSystemFrame = true;
      const issuedAt = Date.now();
      return {
        cells: {
          // The agent's `system` cell → the parent's. The first yield is also
          // the connection handshake: it flips the session to `connected`
          // (idempotent thereafter). Every tick is the parent's authoritative
          // metric-history sampling point (it sees every tick, browser or not).
          system: (remoteSystem) => {
            if (firstSystemFrame) {
              firstSystemFrame = false;
              log(
                `system: first snapshot → marking connected (client #${seq}, ${Date.now() - issuedAt}ms to first RPC)`,
              );
            }
            session.markConnected();
            runtime.ctx.cells.system.set(remoteSystem);
            recordSample(remoteSystem);
          },
          // The agent's `alerts` cell → the parent's. Wire-read-only downstream;
          // the parent only ever mirrors the agent's derived value inward. The
          // agent's own `equals` (`alertsEqual`) already gated the frame, so a
          // frame arriving here is a genuine raise/clear worth re-publishing.
          alerts: (remoteAlerts) => {
            runtime.ctx.cells.alerts.set(remoteAlerts);
          },
        },
        collections: {
          // Small-N per-key collections — the path the private collection
          // engine drives (keys stream + per-key value streams). `coreCache` /
          // `netCache` outlive the per-spawn sink (they're minted once above),
          // so a core/iface that vanished while the ssh link was down would
          // survive as a ghost row across the reconnect. `initialKeys` hands the
          // fresh mirror this spawn's carry-over keys; its first `keys` frame
          // prunes any the snapshot omits — no stale row, no empty flash
          // (kolu #1661; mirrors surface-remote's reServeSurface).
          // `processes` rides the SAME collection-sink path (SR5). Because it
          // declares the `deltas` verb, the mirror folds the agent's ONE coalesced
          // snapshot-then-delta stream into `runtime.ctx.collections.processes`
          // (which writes `processCache` AND re-serves the browser its own coalesced
          // deltas) — no parallel stream fold, no `applySnapshotMessage` reducer.
          processes: {
            upsert: (key, value) =>
              runtime.ctx.collections.processes.upsert(key, value),
            remove: (key) => runtime.ctx.collections.processes.remove(key),
            initialKeys: () => new Set(processCache.keys()),
          },
          cpuCores: {
            upsert: (key, value) =>
              runtime.ctx.collections.cpuCores.upsert(key, value),
            remove: (key) => runtime.ctx.collections.cpuCores.remove(key),
            initialKeys: () => new Set(coreCache.keys()),
          },
          networkInterfaces: {
            upsert: (key, value) =>
              runtime.ctx.collections.networkInterfaces.upsert(key, value),
            remove: (key) =>
              runtime.ctx.collections.networkInterfaces.remove(key),
            initialKeys: () => new Set(netCache.keys()),
          },
        },
      };
    },
    // Publish each spawn's forwarding stubs for the parent's `kill` handler;
    // the pump clears them the instant the link dies, so a kill in the gap
    // fails honestly rather than calling into a dead client.
    liveProcedures,
    // The session's link health (copying / connecting / failed) onto the
    // browser-facing `connection` cell — the pump OWNS this subscription for the
    // session's lifetime and tears it down on exit (kolu #1568), so it can't be
    // forgotten or leak. The cell tracks the SESSION's state, never a mirror frame.
    connection: { set: (info) => runtime.ctx.cells.connection.set(info) },
    log,
  });

  // `metricHistory` is PARENT-LOCAL policy — retention lives here, not on the agent
  // (whose inert stub is gone, SR5). Serve it from its OWN runtime over the parent's
  // ring/bus, then compose it FLAT onto the mirrored agent surface via `extendSurface`:
  // the browser sees ONE surface with `metricHistory` beside the mirrored members, at
  // byte-identical paths, with post-commit observation (the sampler feeds the ring off
  // each mirrored `system` tick) instead of a second mirror.
  // `historySurface` is the shared declaration (drishti-common/browser) so the
  // browser types off the same combined surface the parent serves here.
  const historyRuntime = implementSurface(historySurface, {
    streams: {
      metricHistory: {
        // Yield the parent's current ring on subscribe (a reload / tab-switch
        // replays the whole history), then forward each per-tick delta.
        source: async function* (_input, signal) {
          yield {
            kind: "snapshot",
            samples: [...historyRing],
          } satisfies MetricHistoryMsg;
          for await (const msg of historyBus.subscribe(signal)) {
            yield msg;
          }
        },
      },
    },
  });
  const composed = extendSurface(
    {
      surface: mirroredAgentSurface,
      router: runtime.router,
      done: runtime.done,
      close: runtime.close,
    },
    {
      surface: historySurface,
      router: historyRuntime.router,
      done: historyRuntime.done,
      close: historyRuntime.close,
    },
  );
  return { router: composed.router, session };
}

/** The write-side methods the pump sink is allowed to touch — a
 *  deliberate least-privilege narrowing of `implementSurface(...).ctx`,
 *  not the full ctx. The sink only ever mirrors remote data inward, so it
 *  gets `set` / `upsert` / `remove`; `readAll` and the underlying stores
 *  stay out of reach. This is a boundary, not a maintenance chore: the
 *  `_pumpCtx` guard above assigns the real runtime to this type, so a
 *  collection renamed or retyped on the surface becomes a compile error
 *  here rather than silent drift. */
type FragmentCtx = {
  ctx: {
    cells: {
      system: { set: (v: SystemInfo) => void };
      alerts: { set: (v: Alerts) => void };
      connection: { set: (v: ConnectionInfo) => void };
    };
    collections: {
      processes: {
        upsert: (k: Pid, v: Process) => void;
        remove: (k: Pid) => void;
      };
      cpuCores: {
        upsert: (k: CoreId, v: CpuCore) => void;
        remove: (k: CoreId) => void;
      };
      networkInterfaces: {
        upsert: (k: IfaceName, v: NetInterface) => void;
        remove: (k: IfaceName) => void;
      };
    };
  };
};

// The parent-side `applySnapshotMessage` reducer is gone (SR5): the mirror folds the
// `processes` collection's `deltas` stream straight into
// `runtime.ctx.collections.processes` via the pump's collection sink, with the same
// snapshot-reconcile + carry-over pruning the framework already owns — one process
// protocol, no hand-rolled parent reducer.
