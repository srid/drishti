/**
 * Module-private agent surface runtime (W7.2).
 * Imported by main.ts and fixtures/highContractMain.ts only.
 * Not a package public API — packages/agent/package.json `exports` does not
 * list this module (W8.3). In-repo relative imports (fixtures) still work.
 */

import {
  controlCoreFragment,
  readBakedIdentity,
} from "@kolu/surface-daemon";
import {
  implementSurface,
  implementSurfaces,
  inMemoryChannel,
  inMemoryStore,
  streamFromAbortableSource,
  type Channel,
  type SurfaceHandlers,
} from "@kolu/surface/server";
import { derived, scan, source } from "@kolu/surface/reactor";
import { Effect, Stream } from "effect";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  AGENT_SURFACE_VERSION,
  type CoreId,
  type CpuCore,
  type KillInput,
  type MetricHistoryMsg,
  type MetricSample,
  type SystemInfo,
  surface,
} from "drishti-common";
import {
  agentDaemonSurfaces,
  type DrainVerdict,
} from "drishti-common/daemon";
import {
  applyHysteresis,
  type Alerts,
  type MetricsFrame,
  NO_ALERTS,
} from "drishti-common/alerts";
import {
  captureSample,
  type HistoryView,
  HISTORY_RETENTION_MS,
  pushSample,
} from "drishti-common/history";
import { averageCoreUsage, metricPercents } from "drishti-common/metrics";
import {
  HISTORY_RING_FILE,
  loadHistoryRing,
  saveHistoryRing,
} from "./historyRing";
import { type ProcReader } from "./proc";
import { NO_BASELINES, type RingBaselines } from "./ringBaselines";

const POLL_INTERVAL_MS = 2000;
const RING_PERSIST_INTERVAL_MS = 30_000;

const cpuAggregate = (
  cores: ReadonlyMap<CoreId, CpuCore>,
): { cpuPct: number; coreCount: number } => ({
  cpuPct: averageCoreUsage(Array.from(cores.values(), (c) => c.usagePct)),
  coreCount: cores.size,
});

function log(...args: unknown[]): void {
  process.stderr.write(`${args.map((a) => String(a)).join(" ")}\n`);
}

export function singleFlight(tick: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await tick();
    } finally {
      inFlight = false;
    }
  };
}

/** Outcome of a ring flush — drain must surface a failed final write. */
export type FlushResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: true; skipped: true };

export interface AgentRuntime {
  /** The served surface's flat wire group. `Rpc.Any` is the honest erasure: a
   *  spec-walk-assembled group carries no type a caller could trust, and route-set
   *  identity is asserted inside `implementSurface(s)`, not here. This is what
   *  replaced the `router: any` the oRPC serving path forced. */
  group: RpcGroup.RpcGroup<Rpc.Any>;
  /** Every bound member handler, keyed by full wire tag. */
  handlers: SurfaceHandlers;
  isIdle: () => boolean;
  flushRing: () => FlushResult;
  close: () => Promise<void>;
  done: Promise<void>;
}

export interface BuildAgentRuntimeOptions {
  ringPath?: string;
  onDrain?: (flush: FlushResult) => void | Promise<void>;
  stateRoot?: string;
  withControlCore?: boolean;
  saveRing?: typeof saveHistoryRing;
  /**
   * Module-private test seam (W2.9 / W7.2): override the 30s persist cadence.
   * Never env, never a package-public export.
   */
  ringPersistMs?: number;
  /**
   * Module-private test seam (W7.2): override control-core surfaceVersion for
   * contract-newer refuse fixtures. Never env, never a package-public export.
   * Production always uses AGENT_SURFACE_VERSION.
   */
  surfaceVersionOverride?: string;
}


export async function buildAgentRuntime(
  reader: ProcReader,
  opts: BuildAgentRuntimeOptions,
): Promise<AgentRuntime> {
  // ── Durable history ring FIRST (W3.3) ─────────────────────────────────
  // Load ring + importBaselines BEFORE the first readSystem/readCpuCores so
  // the successor's first tick is not a cold zero-rate frame retained in the
  // reader's one-second cache.
  let historyView: HistoryView = { kind: "ok", samples: [] };
  /** Restored / live hysteresis fold seed. */
  let alertsSeed: Alerts = NO_ALERTS;
  /** Read current alerts from the cell once the runtime is built. */
  let readAlerts: () => Alerts = () => alertsSeed;
  /** Read rate baselines for flush. */
  let readBaselines: () => RingBaselines = () => NO_BASELINES;
  /** When true, never flush to disk (file left alone: unknown-v / unreadable). */
  let persistWithheld = false;
  /**
   * Corrupt load moved the file aside — disk path is free. Stay standing
   * unavailable until the first successful persist of a fresh ring.
   */
  let corruptAwaitingFresh = false;
  let freshSamples: MetricSample[] = [];
  const saveRing = opts.saveRing ?? saveHistoryRing;
  const ringPersistMs = opts.ringPersistMs ?? RING_PERSIST_INTERVAL_MS;

  if (opts.ringPath !== undefined) {
    const loaded = loadHistoryRing(opts.ringPath);
    if (loaded.kind === "ok") {
      historyView = { kind: "ok", samples: loaded.samples };
      // W3.3 / W4.3: seed hysteresis from the ring (mutation → NO_ALERTS reds).
      alertsSeed = loaded.alerts;
      // Restore baselines BEFORE any host/process read (W3.3 / W4.3).
      reader.importBaselines?.(loaded.baselines);
    } else if (
      loaded.reason === "unknown-version" ||
      loaded.reason === "unreadable"
    ) {
      persistWithheld = true;
      historyView = {
        kind: "unavailable",
        reason: loaded.reason,
        samples: [],
      };
      log(
        `history ring standing unavailable (${loaded.reason}) at ${opts.ringPath}`,
      );
    } else {
      corruptAwaitingFresh = true;
      historyView = {
        kind: "unavailable",
        reason: "corrupt",
        samples: [],
      };
      log(
        `history ring corrupt at ${opts.ringPath} — moved aside; standing unavailable until first successful persist`,
      );
    }
  }

  // First system/cpu read AFTER baseline restore — rates are non-zero on a
  // successor that inherited host/process baselines from the ring.
  const systemStore = inMemoryStore({
    ...(await reader.readSystem()),
    ...cpuAggregate(await reader.readCpuCores()),
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  const pollInstall = (tick: () => void): (() => void) => {
    const iv = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(iv);
  };
  const historyBus: Channel<MetricHistoryMsg> =
    inMemoryChannel<MetricHistoryMsg>();

  const publishHistory = (msg: MetricHistoryMsg): void => {
    historyBus.publish(msg);
  };

  readBaselines = () => reader.exportBaselines?.() ?? NO_BASELINES;

  const flushRing = (): FlushResult => {
    if (opts.ringPath === undefined || persistWithheld) {
      return { ok: true, skipped: true };
    }
    // Corrupt-awaiting-fresh: try to materialise the free path; success is
    // the legitimate transition out of standing unavailable.
    if (historyView.kind === "unavailable") {
      if (!corruptAwaitingFresh) return { ok: true, skipped: true };
      try {
        saveRing(
          opts.ringPath,
          freshSamples,
          readAlerts(),
          readBaselines(),
        );
        corruptAwaitingFresh = false;
        historyView = { kind: "ok", samples: [...freshSamples] };
        publishHistory({
          kind: "snapshot",
          samples: [...freshSamples],
        });
        log(
          `history ring recovered after corrupt — fresh ring persisted (${freshSamples.length} samples)`,
        );
        return { ok: true };
      } catch (err) {
        const error = (err as Error).message;
        log(`history ring fresh-persist after corrupt failed: ${error}`);
        return { ok: false, error };
      }
    }
    const samples =
      historyView.kind === "ok" || historyView.kind === "degraded"
        ? historyView.samples
        : [];
    try {
      saveRing(opts.ringPath, samples, readAlerts(), readBaselines());
      // Successful flush after a prior degrade recovers durability.
      if (historyView.kind === "degraded") {
        historyView = { kind: "ok", samples };
        publishHistory({ kind: "snapshot", samples: [...samples] });
      }
      return { ok: true };
    } catch (err) {
      const error = (err as Error).message;
      log(`history ring flush failed: ${error}`);
      // W10 / W2.8: typed degraded — samples still serve; durability loss is
      // visible; result is returned so drain cannot silently succeed.
      historyView = {
        kind: "degraded",
        reason: "persist-failed",
        samples,
      };
      publishHistory({
        kind: "degraded",
        reason: "persist-failed",
        samples: [...samples],
      });
      return { ok: false, error };
    }
  };

  // metricHistory stream lease count. The parent pump holds that stream for
  // the spawn lifetime (UW3); zero leases ⇒ no parent is pumping this daemon
  // ⇒ eligible for daemonMain idleTimeout exit. Not a TCP connection count.
  let metricHistoryLeases = 0;

  /** The metric-history frames one subscriber sees: the STANDING disposition
   *  (unavailable / degraded / ok — never a one-shot, so a late subscriber
   *  learns the same truth an early one did) followed by the live tail.
   *
   *  Subscribing happens BEFORE the standing frame is read, so a tick landing
   *  between them cannot be dropped. */
  async function* historyFrames(
    signal: AbortSignal,
  ): AsyncIterable<MetricHistoryMsg> {
    const tail = historyBus.subscribe(signal);
    if (historyView.kind === "unavailable") {
      yield {
        kind: "unavailable",
        reason: historyView.reason,
      } satisfies MetricHistoryMsg;
    } else if (historyView.kind === "degraded") {
      yield {
        kind: "degraded",
        reason: "persist-failed",
        samples: [...historyView.samples],
      } satisfies MetricHistoryMsg;
    } else {
      yield {
        kind: "snapshot",
        samples: [...historyView.samples],
      } satisfies MetricHistoryMsg;
    }
    for await (const msg of tail) {
      yield msg;
    }
  }

  /** The lease is a SCOPED resource of the stream, not a `finally` inside the
   *  generator — that is load-bearing, not tidiness. The framework's
   *  AsyncIterable bridge deliberately never calls `.return()` on the producer
   *  (awaiting it deadlocks a generator parked at an `await`), so a generator's
   *  `finally` does NOT run when a consumer walks away. Acquire/release runs on
   *  the stream's own scope, which fiber interruption always closes — and the
   *  daemon's idle-exit oracle (`isIdle`) is exactly this counter, so a leaked
   *  lease would keep a forgotten daemon alive forever. */
  const metricHistoryStream = (): Stream.Stream<MetricHistoryMsg> =>
    Stream.unwrap(
      Effect.map(
        Effect.acquireRelease(
          Effect.sync(() => {
            metricHistoryLeases += 1;
          }),
          () =>
            Effect.sync(() => {
              metricHistoryLeases -= 1;
            }),
        ),
        () => streamFromAbortableSource<MetricHistoryMsg>(historyFrames),
      ),
    );

  // The metrics SOURCE feeding the `alerts` reactor graph.
  let emitMetrics: ((f: MetricsFrame) => void) | null = null;
  const metrics = source<MetricsFrame>((emit) => {
    emitMetrics = emit;
    return () => {
      emitMetrics = null;
    };
  });

  const appDeps = {
    cells: {
      system: { store: systemStore },
      // W4: seed hysteresis from the ring so alert state survives drain.
      alerts: derived.cell(scan(metrics, alertsSeed, applyHysteresis)),
    },
    collections: {
      processes: derived.collection(
        source({
          read: () => reader.readProcesses(),
          install: pollInstall,
          label: "processes",
        }),
      ),
      unclaimedListeners: derived.collection(
        source({
          read: () => reader.readUnclaimedListeners(),
          install: pollInstall,
          label: "unclaimedListeners",
        }),
      ),
      sourceErrors: derived.collection(
        source({
          read: () => reader.readSourceErrors(),
          install: pollInstall,
          label: "sourceErrors",
        }),
      ),
      cpuCores: derived.collection(
        source({
          read: () => reader.readCpuCores(),
          install: pollInstall,
          label: "cpuCores",
        }),
      ),
      networkInterfaces: derived.collection(
        source({
          read: () => reader.readNetwork(),
          install: pollInstall,
          label: "networkInterfaces",
        }),
      ),
    },
    streams: {
      metricHistory: {
        source: (): Stream.Stream<MetricHistoryMsg> => metricHistoryStream(),
      },
    },
    procedures: {
      process: {
        kill: ({ input }: { input: KillInput }) =>
          Effect.sync(() => {
            try {
              process.kill(input.pid, `SIG${input.signal}`);
              return { ok: true };
            } catch (err) {
              return { ok: false, error: (err as Error).message };
            }
          }),
      },
    },
  };

  /**
   * The ONE drain: flush the durable ring, then hand the caller-supplied
   * `onDrain` the verdict (which aborts the daemon lifetime) 150ms later.
   *
   * LATCHED, so the two verbs that reach it — drishti's own
   * `daemon.ring.drain` and the framework's frozen `control.core.drain` —
   * flush exactly once between them regardless of order or of a supervisor
   * calling both. Never throws: a failed final write is a REPORTED OUTCOME of a
   * successful drain, not a failure of the call. That distinction is the whole
   * reason drishti owns a drain verb (see `drishti-common/daemon`).
   */
  let drainVerdict: DrainVerdict | null = null;
  const drainNow = (): DrainVerdict => {
    if (drainVerdict !== null) return drainVerdict;
    const flush = flushRing();
    drainVerdict = flush.ok
      ? { persisted: true }
      : { persisted: false, error: flush.error };
    setTimeout(() => {
      void opts.onDrain?.(flush);
    }, 150);
    return drainVerdict;
  };

  // One construction object per branch — no null-then-assign on group/handlers/
  // done/close/setSystem. setSystem is the framework's cell face so
  // equals/onWrite/store.set/bus.publish all fire.
  type BuiltRuntime = {
    group: RpcGroup.RpcGroup<Rpc.Any>;
    handlers: SurfaceHandlers;
    done: Promise<void>;
    close: () => Promise<void>;
    setSystem: (sys: SystemInfo) => void;
  };
  const built: BuiltRuntime = opts.withControlCore
    ? (() => {
        if (opts.stateRoot === undefined || opts.stateRoot === "") {
          throw new Error(
            "buildAgentRuntime: stateRoot is required when withControlCore is true",
          );
        }
        const identity = readBakedIdentity("DRISHTI_AGENT");
        const startedAt = Date.now();
        // W5.8: implement the frozen fragment lawfully — no `control as never`.
        // W6.7: surfaceVersionOverride is the private test seam (like ringPersistMs).
        //
        // `onDrain` NEVER throws. The frozen `drain` declares no error schema, so
        // in this protocol epoch a rejecting hook is a DEFECT — "a daemon whose
        // drain hook throws is broken, not busy". drishti's persist failure is
        // neither: it is a verdict about a drain that worked, and it rides
        // `daemon.ring.drain`'s declared OUTPUT instead.
        const control = controlCoreFragment({
          stateRoot: opts.stateRoot,
          surfaceVersion: opts.surfaceVersionOverride ?? AGENT_SURFACE_VERSION,
          startedAt,
          commit: identity.navigableCommit,
          buildId: identity.staleKey,
          onDrain: () => {
            drainNow();
          },
        });
        const runtime = implementSurfaces(agentDaemonSurfaces, {}, {
          app: appDeps as never,
          control,
          daemon: {
            procedures: {
              ring: { drain: () => Effect.sync(drainNow) },
            },
          },
        } as never);
        // W4: flush must read live hysteresis, not only the boot seed.
        readAlerts = () => runtime.ctx.app.cells.alerts.get() as Alerts;
        return {
          group: runtime.group,
          handlers: runtime.handlers,
          done: runtime.done,
          close: () => runtime.close(),
          setSystem: (sys) => runtime.ctx.app.cells.system.set(sys),
        };
      })()
    : (() => {
        // Test path — single surface, no control core (serveAgent injects a fake serve).
        const runtime = implementSurface(surface, appDeps as never);
        readAlerts = () => runtime.ctx.cells.alerts.get() as Alerts;
        return {
          group: runtime.group,
          handlers: runtime.handlers,
          done: runtime.done,
          close: () => runtime.close(),
          setSystem: (sys) => runtime.ctx.cells.system.set(sys),
        };
      })();

  if (emitMetrics === null)
    throw new Error(
      "alerts reactor: metrics source was never subscribed during surface " +
        "construction — the scan→source eager-subscribe invariant broke",
    );
  // NOTE — `built.done` is deliberately NOT observed here any more.
  //
  // It used to carry a `void built.done.catch(… process.exit(1))`. The verdict
  // was right (a runtime fault is structural death, not a transient) but the
  // mechanism was wrong: a bare exit from inside the runtime builder skips the
  // daemon's shutdown spine, so the unix socket and the pid gate are never
  // released and the history ring is never flushed. A successor then meets a
  // gate naming a dead pid, and the ring has lost everything since the last
  // periodic persist.
  //
  // `done` is returned instead, and whoever OWNS the process decides: the
  // daemon binary arms `armRuntimeFaultExit` and hands the resulting signal to
  // `daemonMain` as `faultSignal`, so the fault tears down in order and exits
  // non-zero. A library that builds a runtime has no business killing a process
  // it does not own — the test path (`serveAgent`) has no daemon to exit at all.

  // W6.5: after restoring non-empty ring alerts, keep them in the hold band
  // for a short grace window so the successor's first served alerts frame
  // reflects pre-drain state before idle host metrics would clear them.
  const alertsRestoreGraceUntil =
    alertsSeed.items.length > 0 ? Date.now() + 8_000 : 0;

  const tick = singleFlight(async (): Promise<void> => {
    try {
      const nextSystem = await reader.readSystem();
      const sys = {
        ...nextSystem,
        ...cpuAggregate(await reader.readCpuCores()),
        pollIntervalMs: POLL_INTERVAL_MS,
      };
      built.setSystem(sys);
      let percents = metricPercents(sys);
      if (Date.now() < alertsRestoreGraceUntil) {
        percents = { ...percents };
        for (const id of alertsSeed.items) {
          if (percents[id] < 75) {
            percents = { ...percents, [id]: 75 };
          }
        }
      }
      emitMetrics?.(percents);

      // Sample the durable ring on each system tick (agent owns the ring).
      // Standing unavailable with persist withheld (unknown-v / unreadable)
      // does not sample into the served view — that would masquerade as ok.
      // Corrupt-awaiting-fresh accumulates into a side buffer; transition to
      // ok only after a successful flush (keeps F9 standing for late subs).
      if (
        historyView.kind === "unavailable" &&
        corruptAwaitingFresh &&
        !persistWithheld
      ) {
        // Accumulate only — recovery persist runs on the ring persist interval
        // (or drain), so standing unavailable stays visible to late subscribers.
        const sample = captureSample(Date.now(), sys);
        freshSamples = pushSample(freshSamples, sample, HISTORY_RETENTION_MS);
      } else if (historyView.kind === "ok") {
        const sample = captureSample(Date.now(), sys);
        historyView = {
          kind: "ok",
          samples: pushSample(
            historyView.samples,
            sample,
            HISTORY_RETENTION_MS,
          ),
        };
        historyBus.publish({ kind: "delta", sample });
      } else if (historyView.kind === "degraded") {
        // W10: keep serving live samples while durability is lost.
        const sample = captureSample(Date.now(), sys);
        historyView = {
          kind: "degraded",
          reason: "persist-failed",
          samples: pushSample(
            historyView.samples,
            sample,
            HISTORY_RETENTION_MS,
          ),
        };
        historyBus.publish({ kind: "delta", sample });
      }
    } catch (err) {
      log(`tick error: ${(err as Error).message}`);
    }
  });
  const interval = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  void tick();

  const persistInterval =
    opts.ringPath !== undefined
      ? setInterval(() => {
          flushRing();
        }, ringPersistMs)
      : null;

  const shutdown = async (): Promise<void> => {
    clearInterval(interval);
    if (persistInterval !== null) clearInterval(persistInterval);
    flushRing();
    await built.close();
  };

  return {
    group: built.group,
    handlers: built.handlers,
    // Callback name required by daemonMain idleTimeout; body is lease-based.
    isIdle: () => metricHistoryLeases === 0,
    flushRing,
    close: shutdown,
    done: built.done,
  };
}

/**
 * Build the surface runtime + poll loop for `reader`, then serve it.
 * Injectable `serve` for tests; production uses daemon/front modes from `main`.
 *
 * Kept for main.test.ts — the production entry points are `--stdio` /
 * `--daemon` below.
 */
/** Test seam: `serve` is required (no silent no-op default). Production
 *  entry points use daemon/front modes, not this helper. */
