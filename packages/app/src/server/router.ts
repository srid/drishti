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
 * here as `bridgeAgentToParent` is now `@kolu/surface-nix-host`'s
 * `pumpRemoteSurface` — lifted verbatim-in-shape from this file so
 * pulam-web's terminal-awareness server can share it. drishti keeps only
 * the surface-specific knowledge the pump deliberately doesn't hold: the
 * per-spawn sink (`makeSink`) that folds the agent's `system` / `cpuCores`
 * / `networkInterfaces` / `processesSnapshot` frames into the parent's
 * local surface, and the `liveProcedures` holder the `kill` forward reads.
 */

import { implement } from "@orpc/server";
import {
  type CellStore,
  type Channel,
  implementSurface,
  inMemoryChannel,
  inMemoryChannelByName,
  inMemoryStore,
} from "@kolu/surface/server";
import { type ProcedureForwarders } from "@kolu/surface/mirror";
import {
  type HostSession,
  pumpRemoteSurface,
  seedConnectionCell,
} from "@kolu/surface-nix-host";
import { browserSurface, type ConnectionInfo } from "drishti-common/browser";
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
  type ProcessesSnapshotMsg,
  type SystemInfo,
  surface,
} from "drishti-common";
import {
  captureSample,
  HISTORY_RETENTION_MS,
  pushSample,
} from "../common/history";
import { type Logger, makeLogger } from "./log";

export interface BuildRouterOptions {
  /** The host this router bridges — used only to tag the bridge's log
   *  lines (`bridge:${host}`). `HostSession` keeps its `host` private,
   *  so the registry (which has it) passes it in explicitly. */
  host: string;
  session: HostSession<typeof surface.contract>;
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
  // The seeded, gate-closed connection cell — the shared `seedConnectionCell()`,
  // not a hand-rolled store. Written by `pumpRemoteSurface` off `session.onState`
  // (the `connection` option below), which owns the subscription + teardown.
  const connection = seedConnectionCell();
  const processCache = new Map<Pid, Process>();
  const coreCache = new Map<CoreId, CpuCore>();
  const netCache = new Map<IfaceName, NetInterface>();
  // Local snapshot bus — every msg the parent receives from the
  // agent's snapshot stream is also re-published here so the parent's
  // own `processesSnapshot` source (consumed by the browser) can
  // forward the same data without re-subscribing to the agent.
  const browserSnapshotBus: Channel<ProcessesSnapshotMsg> =
    inMemoryChannel<ProcessesSnapshotMsg>();
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
  const fragment = implementSurface(browserSurface, {
    // Name-keyed in-memory channel factory — publish/subscribe sites
    // land on the same `Channel<T>` instance per name.
    channel: inMemoryChannelByName(),
    cells: {
      system: { store: systemStore },
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
    streams: {
      // Browser-facing snapshot stream — yields the parent's current
      // process cache on subscribe (synchronous snapshot from local
      // state, no agent round-trip needed) then forwards every delta
      // / snapshot the agent publishes via the parent's local bus.
      processesSnapshot: {
        source: async function* (_input, signal) {
          yield {
            kind: "snapshot",
            entries: [...processCache.entries()],
          } satisfies ProcessesSnapshotMsg;
          for await (const msg of browserSnapshotBus.subscribe(signal)) {
            yield msg;
          }
        },
      },
      // Browser-facing metric-history stream — yields the parent's current
      // ring on subscribe (the full history, so a reload/tab-switch replays
      // it), then forwards each per-tick delta the sampler publishes.
      metricHistory: {
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
  // fragment must satisfy the pump sink's write-only view. Stated here (not
  // only implied by the `makeSink` closure below) so a refactor of that sink
  // can't quietly drop the check — a surface collection rename surfaces as
  // an error on this line.
  const _pumpCtx: FragmentCtx = fragment;
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
      let frames = 0;
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
            fragment.ctx.cells.system.set(remoteSystem);
            recordSample(remoteSystem);
          },
        },
        collections: {
          // Small-N per-key collections — the path the private collection
          // engine drives (keys stream + per-key value streams).
          cpuCores: {
            upsert: (key, value) =>
              fragment.ctx.collections.cpuCores.upsert(key, value),
            remove: (key) => fragment.ctx.collections.cpuCores.remove(key),
          },
          networkInterfaces: {
            upsert: (key, value) =>
              fragment.ctx.collections.networkInterfaces.upsert(key, value),
            remove: (key) =>
              fragment.ctx.collections.networkInterfaces.remove(key),
          },
        },
        streams: {
          // Bulk discriminated-union stream — ONE long-lived stream regardless
          // of process count (vs. keys-stream + N per-key subscribes, a drip
          // over a high-latency ssh link). Each frame is a full keyed-snapshot
          // (first, or on reconnect) or a per-tick delta; `applySnapshotMessage`
          // applies both, and the parent re-publishes the frame verbatim to its
          // browser bus.
          processesSnapshot: {
            input: {},
            onFrame: (msg) => {
              frames += 1;
              applySnapshotMessage(log, msg, processCache, fragment, frames);
              browserSnapshotBus.publish(msg);
            },
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
    connection: { set: (info) => fragment.ctx.cells.connection.set(info) },
    log,
  });

  // `implementSurface` returns a router *fragment* — `{ surface: ... }`
  // wrapping the per-key namespaces. Passing it directly to RPCHandler
  // produces a `surface/surface/...` double-prefix in the matcher tree
  // (no procedure matches what the client sends). Wrap once via
  // `implement(contract).router({...fragment})` to flatten the prefix.
  const router = implement(browserSurface.contract).router({
    ...fragment.router,
  });
  return { router, session };
}

/** The write-side methods the pump sink is allowed to touch — a
 *  deliberate least-privilege narrowing of `implementSurface(...).ctx`,
 *  not the full ctx. The sink only ever mirrors remote data inward, so it
 *  gets `set` / `upsert` / `remove`; `readAll` and the underlying stores
 *  stay out of reach. This is a boundary, not a maintenance chore: the
 *  `_pumpCtx` guard above assigns the real fragment to this type, so a
 *  collection renamed or retyped on the surface becomes a compile error
 *  here rather than silent drift. */
type FragmentCtx = {
  ctx: {
    cells: {
      system: { set: (v: SystemInfo) => void };
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

/** Apply one `processesSnapshot` frame to the parent's local
 *  collection — full reset on `snapshot`, incremental delta on
 *  `delta`. Reads `processCache` directly for the live-PID set; the
 *  framework's `upsert`/`remove` keep the cache and the per-key
 *  channels in lockstep, so there's no separate shadow set to
 *  maintain here. */
function applySnapshotMessage(
  log: Logger,
  msg: ProcessesSnapshotMsg,
  processCache: Map<Pid, Process>,
  fragment: FragmentCtx,
  frameNumber: number,
): void {
  if (msg.kind === "snapshot") {
    const next = new Set(msg.entries.map(([pid]) => pid));
    for (const pid of [...processCache.keys()]) {
      if (!next.has(pid)) fragment.ctx.collections.processes.remove(pid);
    }
    for (const [pid, value] of msg.entries) {
      fragment.ctx.collections.processes.upsert(pid, value);
    }
    log(
      `processes: snapshot frame #${frameNumber} — ${msg.entries.length} PIDs (cold-start or reconnect)`,
    );
    return;
  }
  for (const [pid, value] of msg.upserts) {
    fragment.ctx.collections.processes.upsert(pid, value);
  }
  for (const pid of msg.removes) {
    fragment.ctx.collections.processes.remove(pid);
  }
  // Per-tick delta frames are intentionally NOT logged — the agent
  // polls every 2s, so steady-state deltas would dominate stderr. The
  // snapshot frame above and the stream-close/error logs in
  // pumpProcessesSnapshot are the load-bearing signals; if you need
  // per-tick visibility, attach a debugger or temporarily re-enable
  // the line below.
  // log(`processes: delta frame #${frameNumber} — upsert=… remove=… total=…`);
}
