/**
 * Parent-side router — bridges browser ↔ remote agent.
 *
 * The browser subscribes to the same `surface` as the agent serves. The
 * parent doesn't re-define a different surface; it implements the agent
 * surface locally by *forwarding* every read to the remote client.
 * On a fresh subscriber, the parent:
 *
 *   1. Synchronously yields the parent's connection-state-aware
 *      `system` snapshot (state = "probing" / "provisioning" / "connecting" / etc.).
 *   2. Once the agent's link is up, mirrors the agent's `system` and
 *      `processes` updates into the parent's local store/collection.
 *   3. Per-key process upserts/removes from the agent flow through to
 *      the framework's channels and on to the browser.
 *
 * UW3: the durable metric-history ring lives in the agent daemon. The parent
 * pumps the agent's `metricHistory` stream into a local ring/bus and re-serves
 * it to browsers. On link-down the parent does NOT clear the ring — reconnect
 * re-seeds from the agent (which still holds the on-disk ring).
 *
 * R7 keystone (kolu #1505): the reconnect-mirror loop is
 * `@kolu/surface-remote`'s `pumpRemoteSurface`. drishti keeps only the
 * surface-specific knowledge: the per-spawn sink (`makeSink`) and the
 * `liveProcedures` holder the `kill` forward reads.
 */

import {
  type CellStore,
  type Channel,
  implementSurface,
  inMemoryChannel,
  inMemoryStore,
} from "@kolu/surface/server";
import { type ProcedureForwarders } from "@kolu/surface/mirror";
import {
  type AgentClient,
  pumpRemoteSurface,
  type Session,
  type SshProv,
} from "@kolu/surface-remote";
import { mirroredAgentSurface } from "drishti-common/browser";
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
  type SourceErrorFact,
  type SystemInfo,
  type UnclaimedListener,
  type UnclaimedListenerId,
  surface,
} from "drishti-common";
import { type Alerts, NO_ALERTS } from "drishti-common/alerts";
import {
  HISTORY_RETENTION_MS,
  pushSample,
} from "../common/history";
import type { HostSession } from "./hostRegistry";
import { makeLogger } from "./log";

export interface BuildRouterOptions {
  /** The host this router bridges — used only to tag the bridge's log
   *  lines (`bridge:${host}`). The `Session` keeps its `host` private,
   *  so the registry (which has it) passes it in explicitly. */
  host: string;
  session: HostSession;
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
  const processCache = new Map<Pid, Process>();
  const unclaimedListenerCache = new Map<
    UnclaimedListenerId,
    UnclaimedListener
  >();
  const sourceErrorCache = new Map<string, SourceErrorFact>();
  const coreCache = new Map<CoreId, CpuCore>();
  const netCache = new Map<IfaceName, NetInterface>();

  // Parent-side re-serve of the agent's durable metric-history ring.
  // Seeded/refreshed from the agent `metricHistory` stream frames via
  // makeSink.streams — NOT sampled here from system ticks (the agent owns
  // sampling + on-disk persistence). On link-down we keep the ring so a
  // brief reconnect does not flash an empty chart; the next agent snapshot
  // re-seeds authoritatively.
  let historyRing: MetricSample[] = [];
  let historyUnavailable: "unknown-version" | "corrupt" | null = null;
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

  // Implements the agent surface (including durable metricHistory). The base
  // primitives are forwarded/folded from the agent; the seeded local store is
  // what the session pump writes.
  const runtime = implementSurface(mirroredAgentSurface, {
    cells: {
      system: { store: systemStore },
      alerts: { store: alertsStore },
    },
    collections: {
      processes: {
        readAll: () => processCache,
        upsert: (key, value) => {
          processCache.set(key, value);
        },
        remove: (key) => {
          processCache.delete(key);
        },
      },
      unclaimedListeners: {
        readAll: () => unclaimedListenerCache,
        upsert: (key, value) => {
          unclaimedListenerCache.set(key, value);
        },
        remove: (key) => {
          unclaimedListenerCache.delete(key);
        },
      },
      sourceErrors: {
        readAll: () => sourceErrorCache,
        upsert: (key, value) => {
          sourceErrorCache.set(key, value);
        },
        remove: (key) => {
          sourceErrorCache.delete(key);
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
      metricHistory: {
        // Yield the parent's current ring (or a typed unavailable) on
        // subscribe, then forward each agent-driven frame.
        source: async function* (_input, signal) {
          if (historyUnavailable !== null) {
            yield {
              kind: "unavailable",
              reason: historyUnavailable,
            } satisfies MetricHistoryMsg;
          } else {
            yield {
              kind: "snapshot",
              samples: [...historyRing],
            } satisfies MetricHistoryMsg;
          }
          for await (const msg of historyBus.subscribe(signal)) {
            yield msg;
          }
        },
      },
    },
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

  // Compile-time guard for the least-privilege narrowing.
  const _pumpCtx: FragmentCtx = runtime;
  void _pumpCtx;

  /** Fold one agent metricHistory frame into the parent's ring/bus. */
  const applyHistoryFrame = (msg: MetricHistoryMsg): void => {
    switch (msg.kind) {
      case "snapshot": {
        historyUnavailable = null;
        historyRing = [...msg.samples];
        historyBus.publish(msg);
        return;
      }
      case "delta": {
        // Deltas against an unavailable disposition would silently populate
        // a chart that should stay typed-unavailable — refuse them.
        if (historyUnavailable !== null) return;
        historyRing = pushSample(
          historyRing,
          msg.sample,
          HISTORY_RETENTION_MS,
        );
        historyBus.publish(msg);
        return;
      }
      case "unavailable": {
        // Typed disposition — never clear to an empty chart silently.
        historyUnavailable = msg.reason;
        historyRing = [];
        historyBus.publish(msg);
        return;
      }
      default: {
        const _exhaustive: never = msg;
        throw new Error(
          `unreachable MetricHistoryMsg: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  };

  // ── Bridge remote agent surface → parent's local surface ──────────
  void pumpRemoteSurface({
    source: surface,
    session: session as Session<AgentClient<typeof surface.contract>, SshProv>,
    makeSink: ({ seq }) => {
      let firstSystemFrame = true;
      const issuedAt = Date.now();
      return {
        cells: {
          system: (remoteSystem) => {
            if (firstSystemFrame) {
              firstSystemFrame = false;
              log(
                `system: first snapshot → marking connected (client #${seq}, ${Date.now() - issuedAt}ms to first RPC)`,
              );
            }
            session.markConnected();
            runtime.ctx.cells.system.set(remoteSystem);
            // History sampling is the AGENT's job (durable ring). Parent
            // only folds the agent's metricHistory stream (below).
          },
          alerts: (remoteAlerts) => {
            runtime.ctx.cells.alerts.set(remoteAlerts);
          },
        },
        collections: {
          processes: {
            upsert: (key, value) =>
              runtime.ctx.collections.processes.upsert(key, value),
            remove: (key) => runtime.ctx.collections.processes.remove(key),
            initialKeys: () => new Set(processCache.keys()),
          },
          unclaimedListeners: {
            upsert: (key, value) =>
              runtime.ctx.collections.unclaimedListeners.upsert(key, value),
            remove: (key) =>
              runtime.ctx.collections.unclaimedListeners.remove(key),
            initialKeys: () => new Set(unclaimedListenerCache.keys()),
          },
          sourceErrors: {
            upsert: (key, value) =>
              runtime.ctx.collections.sourceErrors.upsert(key, value),
            remove: (key) => runtime.ctx.collections.sourceErrors.remove(key),
            initialKeys: () => new Set(sourceErrorCache.keys()),
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
        streams: {
          // Seed/refresh the parent ring from the agent's durable history.
          // On reconnect the agent re-sends a full snapshot — do not clear
          // the ring on link-down (onLinkDown is intentionally a no-op for
          // history).
          metricHistory: {
            input: {},
            onFrame: (msg) => {
              applyHistoryFrame(msg);
            },
          },
        },
      };
    },
    liveProcedures,
    // Link-down: keep historyRing so a brief reconnect does not flash empty.
    // The next agent snapshot re-seeds authoritatively.
    onLinkDown: () => {
      log("agent link down — keeping history ring until next agent snapshot");
    },
    log,
  });

  return { router: runtime.router, session };
}

/** The write-side methods the pump sink is allowed to touch — a
 *  deliberate least-privilege narrowing of `implementSurface(...).ctx`,
 *  not the full ctx. The sink only ever mirrors remote data inward, so it
 *  gets `set` / `upsert` / `remove`; `readAll` and the underlying stores
 *  stay out of reach. */
type FragmentCtx = {
  ctx: {
    cells: {
      system: { set: (v: SystemInfo) => void };
      alerts: { set: (v: Alerts) => void };
    };
    collections: {
      processes: {
        upsert: (k: Pid, v: Process) => void;
        remove: (k: Pid) => void;
      };
      unclaimedListeners: {
        upsert: (k: UnclaimedListenerId, v: UnclaimedListener) => void;
        remove: (k: UnclaimedListenerId) => void;
      };
      sourceErrors: {
        upsert: (k: string, v: SourceErrorFact) => void;
        remove: (k: string) => void;
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
