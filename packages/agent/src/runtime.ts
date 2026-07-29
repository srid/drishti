/**
 * Module-private agent surface runtime (W7.2).
 * Imported by main.ts and fixtures/highContractMain.ts only.
 * Not a package public API — agent package has no exports map entry for this.
 */

import { ORPCError } from "@orpc/client";
import {
  controlCoreFragment,
  controlCoreSurface,
  readBakedIdentity,
} from "@kolu/surface-daemon";
import {
  implementSurface,
  implementSurfaces,
  inMemoryChannel,
  inMemoryStore,
  type Channel,
} from "@kolu/surface/server";
import { derived, scan, source } from "@kolu/surface/reactor";
import {
  AGENT_SURFACE_VERSION,
  type CoreId,
  type CpuCore,
  type MetricHistoryMsg,
  type MetricSample,
  type SystemInfo,
  surface,
} from "drishti-common";
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
  // biome-ignore lint/suspicious/noExplicitAny: top-level oRPC router
  router: any;
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
        source: async function* (
          _input: Record<string, never>,
          signal: AbortSignal | undefined,
        ): AsyncIterable<MetricHistoryMsg> {
          metricHistoryLeases += 1;
          try {
            // Subscribe BEFORE the first frame so a tick cannot drop a sample.
            const tail = historyBus.subscribe(signal);
            // STANDING state: every subscriber (including late ones) sees
            // unavailable / degraded / ok as currently held — no one-shot.
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
          } finally {
            metricHistoryLeases -= 1;
          }
        },
      },
    },
    procedures: {
      process: {
        kill: ({ input }: { input: { pid: number; signal: string } }) => {
          try {
            process.kill(input.pid, `SIG${input.signal}`);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: (err as Error).message };
          }
        },
      },
    },
  };

  // One construction object per branch — no null-then-assign on router/done/close/setSystem.
  // setSystem is the framework's cell face so equals/onWrite/store.set/bus.publish all fire.
  type BuiltRuntime = {
    // biome-ignore lint/suspicious/noExplicitAny: top-level oRPC router.
    router: any;
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
        // W4.2: control-core drain is FROZEN void. Success returns void; final
        // flush failure throws typed ORPCError (data carries the failure). The
        // parent wraps fireDrain to capture the rejection — never decorate the
        // wire schema or return illegal success objects.
        // W5.8: implement the frozen fragment lawfully — no `control as never`.
        // W6.7: surfaceVersionOverride is the private test seam (like ringPersistMs).
        const control = controlCoreFragment({
          stateRoot: opts.stateRoot,
          surfaceVersion: opts.surfaceVersionOverride ?? AGENT_SURFACE_VERSION,
          startedAt,
          commit: identity.navigableCommit,
          buildId: identity.staleKey,
          onDrain: async () => {
            const flush = flushRing();
            setTimeout(() => {
              void opts.onDrain?.(flush);
            }, 150);
            if (!flush.ok) {
              throw new ORPCError("DRISHTI_PERSIST_FAILED", {
                message: flush.error,
                data: {
                  persistFailed: true as const,
                  error: flush.error,
                },
              });
            }
          },
        });
        const runtime = implementSurfaces(
          { app: surface, control: controlCoreSurface },
          {},
          { app: appDeps as never, control },
        );
        // W4: flush must read live hysteresis, not only the boot seed.
        readAlerts = () => runtime.ctx.app.cells.alerts.get() as Alerts;
        return {
          router: runtime.router,
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
          router: runtime.router,
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
  void built.done.catch((err: unknown) => {
    log(`surface runtime fault: ${(err as Error).message} — exiting`);
    process.exit(1);
  });

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
    router: built.router,
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
