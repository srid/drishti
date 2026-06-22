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
import { mirrorRemoteSurface } from "@kolu/surface/mirror";
import {
  type AgentClient,
  type HostSession,
  makeClientCursor,
} from "@kolu/surface-nix-host";
import {
  type ConnectionInfo,
  type CoreId,
  type CpuCore,
  DEFAULT_CONNECTION,
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

type DrishtiAgent = AgentClient<typeof surface.contract>;

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
  const connectionStore: CellStore<ConnectionInfo> = inMemoryStore({
    ...DEFAULT_CONNECTION,
  });
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

  const fragment = implementSurface(surface, {
    // Name-keyed in-memory channel factory — publish/subscribe sites
    // land on the same `Channel<T>` instance per name.
    channel: inMemoryChannelByName(),
    cells: {
      system: { store: systemStore },
      connection: { store: connectionStore },
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
  });

  // Compile-time guard for the least-privilege narrowing: the real
  // fragment must satisfy the pumps' write-only view. Stated here (not only
  // implied by the bridgeAgentToParent call) so a refactor of that call
  // can't quietly drop the check — a surface collection rename surfaces as
  // an error on this line.
  const _pumpCtx: FragmentCtx = fragment;
  void _pumpCtx;

  // ── Mirror session connection state → parent's `connection` cell ──
  session.onState((s) => {
    fragment.ctx.cells.connection.set({
      state: s.connection,
      lastError: s.lastError,
      failureCause: s.failureCause,
      progressLines: [...s.progressLines],
    });
  });

  // Sample the metric ring once per agent system tick. CPU% is the mean of
  // the cores currently mirrored into `coreCache` (pumped concurrently);
  // memory% comes from the just-arrived system snapshot. `pushSample`
  // evicts points past the retention bound, and the delta goes to every
  // live browser subscriber.
  const recordSample = (system: SystemInfo): void => {
    const sample = captureSample(
      Date.now(),
      system,
      [...coreCache.values()].map((c) => c.usagePct),
    );
    historyRing = pushSample(historyRing, sample, HISTORY_RETENTION_MS);
    historyBus.publish({ kind: "delta", sample });
  };

  // ── Bridge remote agent surface → parent's local surface ──────────
  // Start a background pump that pins the session, then loops over each
  // successive AgentClient the session produces — each time the agent
  // process is respawned (after a transport drop), the bridge fetches
  // the new client and re-issues ONE `mirrorRemoteSurface` against it. The
  // framework's `ClientRetryPlugin` is NOT load-bearing here: stdio links
  // don't recover mid-stream (the underlying streams die with the process),
  // so the only reliable recovery is to re-mirror on the *new* client. The
  // outer loop is what implements "reconnect → state reconciles, no ghosts".
  void bridgeAgentToParent(
    log,
    session,
    fragment,
    processCache,
    browserSnapshotBus,
    recordSample,
  );

  // `implementSurface` returns a router *fragment* — `{ surface: ... }`
  // wrapping the per-key namespaces. Passing it directly to RPCHandler
  // produces a `surface/surface/...` double-prefix in the matcher tree
  // (no procedure matches what the client sends). Wrap once via
  // `implement(contract).router({...fragment})` to flatten the prefix.
  const router = implement(surface.contract).router({ ...fragment.router });
  return { router, session };
}

/** The write-side methods the bridge pumps are allowed to touch — a
 *  deliberate least-privilege narrowing of `implementSurface(...).ctx`,
 *  not the full ctx. Pumps only ever mirror remote data inward, so they
 *  get `set` / `upsert` / `remove`; `readAll` and the underlying stores
 *  stay out of reach. This is a boundary, not a maintenance chore: the
 *  `_pumpCtx` guard below assigns the real fragment to this type, so a
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

/** Pin the session, then loop: fetch the current AgentClient, mirror the
 *  WHOLE agent surface into the parent with one `mirrorRemoteSurface` call,
 *  wait for it to settle (which happens when the link errors — stdio process
 *  death), then wait for the session to provide a fresh client
 *  (post-reconnect) and repeat.
 *
 *  Each loop iteration owns one client — a fresh ssh subprocess. The
 *  `clientSeq` counter labels them (`#1`, `#2`, …) so the otherwise
 *  identical per-reconnect log lines can be traced to a specific spawn:
 *  if the mirror against `#2` never yields a `system` frame while the agent
 *  on the far end logged `serving surface over stdio`, the handoff — not the
 *  remote — is where a stuck reconnect lives.
 *
 *  The four hand-rolled pumps (system cell, cpuCores + networkInterfaces
 *  collections, processesSnapshot stream) collapse into one declarative sink
 *  — the consume-side dual of the `implementSurface` call that built the
 *  parent's own surface above. The reconnect-loop primitive
 *  (`makeClientCursor`) and the per-client re-mirror stay the bridge's job,
 *  because stdio links don't recover mid-stream. */
async function bridgeAgentToParent(
  log: Logger,
  session: HostSession<typeof surface.contract>,
  fragment: FragmentCtx,
  processCache: Map<Pid, Process>,
  browserSnapshotBus: Channel<ProcessesSnapshotMsg>,
  recordSample: (system: SystemInfo) => void,
): Promise<void> {
  log("pinning HostSession (parent-lifetime ref)…");
  // Pin once. Swallow the initial promise — we'll fetch a fresh client
  // (possibly a re-spawned one) in the loop below regardless of whether
  // this first spawn succeeded.
  session.pin().catch(() => {
    /* logged via state cell; loop handles recovery */
  });

  // A cursor over the session's spawn lifecycle — `next()` blocks until a
  // genuinely new spawn appears and resolves with its live client (it owns
  // the stable-clientPromise comparison that keeps the loop from busy-
  // spinning once a dead link fails fast).
  const cursor = makeClientCursor(session);
  let clientSeq = 0;
  while (!session.isDestroyed()) {
    let client: DrishtiAgent;
    try {
      client = await cursor.next();
    } catch (err) {
      log(`bridge: waiting for next client failed: ${(err as Error).message}`);
      break;
    }
    clientSeq += 1;
    const seq = clientSeq;
    log(`agent client ready (client #${seq}); starting mirror`);
    // Per-client mirror state — the agent leads each (re)connect with a fresh
    // `system` snapshot, so the first-frame handshake markers and the frame
    // counter reset with the client.
    let firstSystemFrame = true;
    let frames = 0;
    const issuedAt = Date.now();
    // R7 (kolu #1505): `mirrorRemoteSurface` returns the total-dual handle
    // `{ procedures, done }`, no longer `Promise<void>`. The bridge loop must
    // block until the link dies, so await `.done` — a bare `await
    // mirrorRemoteSurface(...)` would await a non-thenable handle and resolve
    // at once, spinning the reconnect loop. (This consumer mirrors streaming
    // sinks only; `.procedures` is unused here.)
    await mirrorRemoteSurface(
      surface,
      client,
      {
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
      },
      { log },
    ).done;
    log(
      `bridge: mirror ended for client #${seq} (link likely died) — awaiting next client`,
    );
  }
  log("bridge: session destroyed — exiting reconnect loop");
}

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
