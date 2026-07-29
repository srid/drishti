/**
 * drishti-agent entrypoint — one binary, two modes (UW3).
 *
 * Modes:
 *   --stdio                   durable stdio front (`frontDaemonOverStdio`):
 *                             adopt the running daemon or spawn one, then
 *                             raw-byte-relay this process's stdio onto its
 *                             unix socket. What `ssh $host $agent --stdio`
 *                             invokes.
 *   --daemon                  (or no flag) serve the agent surface over a
 *                             unix socket via `daemonMain` / `daemonProcessMain`.
 *                             Idle-exits after 60 minutes with no metricHistory
 *                             stream leases (parent pump holds one per spawn).
 *   --broken-stdout-log       deliberately log a stray line to stdout before
 *                             any RPC (stdio front only). Smoke-test only.
 *
 * All durable files live under `daemonHome({ app: "drishti", placement: "state" })`
 * → `~/.local/state/drishti/` (gate, socket, `history.ring.json`). Never
 * $XDG_RUNTIME_DIR — logind deletes that with the session.
 *
 * The agent polls `proc` and `system` every `POLL_INTERVAL_MS` and pushes
 * deltas through the surface's typed `ctx`. The metric-history ring is
 * sampled on each system tick, persisted every 30s and on drain.
 *
 * **Stdout is the protocol channel in --stdio mode.** All logging goes to
 * fd 2 (`process.stderr.write`).
 */

import {
  controlCoreFragment,
  controlCoreSurface,
  daemonHome,
  daemonMain,
  daemonProcessMain,
  frontDaemonOverStdio,
  reExecAsDetachedDaemon,
  readBakedIdentity,
  stderrLogger,
} from "@kolu/surface-daemon";
import {
  implementSurface,
  implementSurfaces,
  inMemoryChannel,
  inMemoryStore,
  type Channel,
} from "@kolu/surface/server";
// The reactive bridge (kolu W5, phase 0). This import is CORRECT here and only
// here: the agent is the surface's serving endpoint, so folding host metrics
// into the `alerts` cell through a backend signal graph belongs in the agent's
// main.ts. It must NOT reach the agent-SHARED graph (`drishti-common`) — the
// agent-boots CI check guards exactly that — so the pure fold lives in
// `drishti-common/alerts` (reactor-free) and the graph that DRIVES it lives
// here.
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
import { createProcReader, type ProcReader } from "./proc";

const POLL_INTERVAL_MS = 2000;
/** How often the durable ring is flushed to disk while running. Drain also flushes.
 *  Override via DRISHTI_RING_PERSIST_MS (test seam for W10 / e2e). */
const RING_PERSIST_INTERVAL_MS = (() => {
  const raw = process.env.DRISHTI_RING_PERSIST_MS;
  if (raw === undefined || raw === "") return 30_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();
/** Idle-exit after this many ms with no live parent connections. */
const IDLE_TIMEOUT_MS = 60 * 60_000;

// The host-CPU aggregate, folded into the `system` cell so a glance card reads
// one scalar instead of subscribing to every per-core cell (which opens N
// per-core value streams per host — the fleet's O(hosts×cores) CPU sink). The
// agent is the natural producer: it already reads per-core usage each tick.
const cpuAggregate = (
  cores: ReadonlyMap<CoreId, CpuCore>,
): { cpuPct: number; coreCount: number } => ({
  cpuPct: averageCoreUsage(Array.from(cores.values(), (c) => c.usagePct)),
  coreCount: cores.size,
});

function log(...args: unknown[]): void {
  process.stderr.write(`${args.map((a) => String(a)).join(" ")}\n`);
}

function usage(exitCode = 1): never {
  process.stderr.write(
    [
      "drishti-agent — durable host-telemetry surface over stdio / unix socket.",
      "",
      "Usage:",
      "  drishti-agent --stdio                 # front the durable daemon over stdin/stdout",
      "  drishti-agent --stdio --broken-stdout-log",
      "                                         # stdout corruption smoke test (front only)",
      "  drishti-agent [--daemon]              # serve the durable daemon (default)",
      "",
      "Files live under ~/.local/state/drishti/ (gate, socket, history.ring.json).",
      "The daemon idle-exits after 60 minutes with no connections.",
      // stderrLog: reExecAsDetachedDaemon truncates on each spawn (keeps one .old).
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

/** Wrap an async tick so a fire that lands while a previous run is still in
 *  flight is SKIPPED — the same non-overlap law the framework's poll source
 *  applies to the keyed collections, owned here for the one hand-rolled
 *  `setInterval` left in the agent:
 *  the system/alerts tick. Without it a slow osfacts host read overlaps itself
 *  every 2s on a wedged host — the drishti#111 pileup class. Skipping (not
 *  queueing) is correct for a poll: the next interval fire re-samples.
 *
 *  SOUND ONLY BECAUSE THE READS SETTLE: the guard releases in `finally`, so a
 *  never-settling tick would freeze the cell forever — which is why every
 *  osfacts client command carries a five-second SIGKILL budget. Exported for
 *  main.test.ts. */
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

/** The serve operation `serveAgent` calls — narrowed to the one shape it
 *  uses, so a test can inject a fake (the default is the real stdio
 *  transport, which is assignable to this). Module-private and named for the
 *  *role*, not a particular transport. Resolves to `unknown` because the agent
 *  only awaits serving's *end*, not its value. */
type Serve = (opts: {
  // biome-ignore lint/suspicious/noExplicitAny: the kolu handler's router type.
  router: any;
  onFirstRequest: () => void;
}) => Promise<unknown>;

interface AgentRuntime {
  // biome-ignore lint/suspicious/noExplicitAny: top-level oRPC router for daemonMain / serve.
  router: any;
  /**
   * `daemonMain` idleTimeout option name is fixed (`isIdle`). Semantics here:
   * true when the metricHistory stream lease count is zero. The parent pump
   * holds that stream for the spawn lifetime — this is NOT a generic TCP
   * connection count.
   */
  isIdle: () => boolean;
  /** Flush the history ring to disk (idempotent). Surfaces typed degraded on failure. */
  flushRing: () => void;
  /** Tear down poll loops / surface sources. */
  close: () => Promise<void>;
  done: Promise<void>;
}

interface BuildAgentRuntimeOptions {
  /** Absolute path for the durable history ring. Required for daemon mode. */
  ringPath?: string;
  /** Fired after the ring is flushed on control-core drain (daemon mode). */
  onDrain?: () => void | Promise<void>;
  /** Daemon home — required when withControlCore is true. */
  stateRoot?: string;
  /** Whether to compose the control-core fragment (daemon mode). Tests omit it. */
  withControlCore?: boolean;
  /** Test-only: inject saveHistoryRing failure (W10 mutation). */
  saveRing?: typeof saveHistoryRing;
}

/**
 * Build the agent surface runtime + poll loop for `reader`. Module-private —
 * not a public production API (W11). Shared by daemon main and serveAgent tests.
 *
 * **Serve before you enumerate.** The connect handshake needs only the cheap
 * `system` snapshot, so that is the one read we seed before returning. The
 * process/socket snapshot starts empty and the poll loop fills it.
 */
async function buildAgentRuntime(
  reader: ProcReader,
  opts: BuildAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const systemStore = inMemoryStore({
    ...(await reader.readSystem()),
    ...cpuAggregate(await reader.readCpuCores()),
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  const pollInstall = (tick: () => void): (() => void) => {
    const iv = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(iv);
  };

  // ── Durable history ring (W2 standing unavailable; W4 alerts; W10 flush) ──
  // unavailable is STANDING: every subscriber sees it until a legitimate
  // transition. unknown-version / unreadable stay unavailable (file left alone).
  // corrupt starts unavailable (F9); first successful sample transitions to ok
  // once the corrupt file has been moved aside (disk path free).
  let historyView: HistoryView = { kind: "ok", samples: [] };
  /** Restored / live hysteresis fold seed (W4). */
  let alertsSeed: Alerts = NO_ALERTS;
  /** Read current alerts from the cell once the runtime is built. */
  let readAlerts: () => Alerts = () => alertsSeed;
  /** When true, never flush to disk (file left alone: unknown-v / unreadable). */
  let persistWithheld = false;
  /**
   * Corrupt load moved the file aside — disk path is free. Stay standing
   * unavailable until the first successful persist of a fresh ring (so every
   * subscriber — including late ones after boot — still sees typed
   * unavailable for F9 / W2). Sampling accumulates into `freshSamples` only.
   */
  let corruptAwaitingFresh = false;
  let freshSamples: MetricSample[] = [];
  const saveRing = opts.saveRing ?? saveHistoryRing;

  if (opts.ringPath !== undefined) {
    const loaded = loadHistoryRing(opts.ringPath);
    if (loaded.kind === "ok") {
      historyView = { kind: "ok", samples: loaded.samples };
      alertsSeed = loaded.alerts;
    } else if (
      loaded.reason === "unknown-version" ||
      loaded.reason === "unreadable"
    ) {
      // STANDING unavailable; file left alone; stream reports unavailable —
      // never an ok-empty masquerade (W2).
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
      // Corrupt: file already moved aside. Stand unavailable until a fresh
      // ring is successfully written to the free path.
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
  const historyBus: Channel<MetricHistoryMsg> =
    inMemoryChannel<MetricHistoryMsg>();

  const publishHistory = (msg: MetricHistoryMsg): void => {
    historyBus.publish(msg);
  };

  const flushRing = (): void => {
    if (opts.ringPath === undefined || persistWithheld) return;
    // Corrupt-awaiting-fresh: try to materialise the free path; success is
    // the legitimate transition out of standing unavailable.
    if (historyView.kind === "unavailable") {
      if (!corruptAwaitingFresh) return;
      try {
        saveRing(opts.ringPath, freshSamples, readAlerts());
        corruptAwaitingFresh = false;
        historyView = { kind: "ok", samples: [...freshSamples] };
        publishHistory({
          kind: "snapshot",
          samples: [...freshSamples],
        });
        log(
          `history ring recovered after corrupt — fresh ring persisted (${freshSamples.length} samples)`,
        );
      } catch (err) {
        log(
          `history ring fresh-persist after corrupt failed: ${(err as Error).message}`,
        );
      }
      return;
    }
    const samples =
      historyView.kind === "ok" || historyView.kind === "degraded"
        ? historyView.samples
        : [];
    try {
      saveRing(opts.ringPath, samples, readAlerts());
      // Successful flush after a prior degrade recovers durability.
      if (historyView.kind === "degraded") {
        historyView = { kind: "ok", samples };
        publishHistory({ kind: "snapshot", samples: [...samples] });
      }
    } catch (err) {
      log(`history ring flush failed: ${(err as Error).message}`);
      // W10: typed degraded — samples still serve; durability loss is visible.
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
        const control = controlCoreFragment({
          stateRoot: opts.stateRoot,
          surfaceVersion: AGENT_SURFACE_VERSION,
          startedAt,
          commit: identity.navigableCommit,
          buildId: identity.staleKey,
          onDrain: async () => {
            flushRing();
            await opts.onDrain?.();
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

  const tick = singleFlight(async (): Promise<void> => {
    try {
      const nextSystem = await reader.readSystem();
      const sys = {
        ...nextSystem,
        ...cpuAggregate(await reader.readCpuCores()),
        pollIntervalMs: POLL_INTERVAL_MS,
      };
      built.setSystem(sys);
      emitMetrics?.(metricPercents(sys));

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
        }, RING_PERSIST_INTERVAL_MS)
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
export async function serveAgent(
  reader: ProcReader,
  serve: Serve,
): Promise<void> {
  const runtime = await buildAgentRuntime(reader, { withControlCore: false });
  log("serving surface (test/injectable path)");
  const servingSince = Date.now();
  const waitingHeartbeat = setInterval(() => {
    log(
      `waiting for first RPC (${Math.round((Date.now() - servingSince) / 1000)}s)…`,
    );
  }, 5000);
  await serve({
    router: runtime.router,
    onFirstRequest: () => {
      clearInterval(waitingHeartbeat);
      log(`first RPC received — link is live (pid=${process.pid})`);
    },
  });
  clearInterval(waitingHeartbeat);
  // Tear down without blocking forever on an in-flight collection seed
  // (main.test.ts deliberately gates process enumeration so the first RPC
  // can prove it doesn't wait). Production daemon mode awaits `close` after
  // the socket is down, when no seed is parked on a test gate.
  void runtime.close();
  log("serve ended — agent runtime closing");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) usage(0);

  const wantStdio = args.includes("--stdio");
  const brokenStdoutLog = args.includes("--broken-stdout-log");

  if (brokenStdoutLog && !wantStdio) {
    log("--broken-stdout-log is only valid with --stdio");
    process.exit(1);
  }

  // Durable state dir — never $XDG_RUNTIME_DIR. Materialises 0700.
  const home = daemonHome({ app: "drishti", placement: "state" });

  if (wantStdio) {
    if (brokenStdoutLog) {
      process.stdout.write("DEBUG: this line corrupts the protocol channel\n");
    }
    log(`drishti-agent --stdio: fronting daemon at ${home.socketPath}`);
    await frontDaemonOverStdio({
      socketPath: home.socketPath,
      spawnDaemon: () =>
        reExecAsDetachedDaemon({
          stripArgs: ["--stdio", "--broken-stdout-log"],
          stderrLog: home.file("agent.stderr.log"),
        }),
      log: (msg) => process.stderr.write(`drishti-agent --stdio: ${msg}\n`),
    });
    return;
  }

  // Daemon mode (default, or explicit --daemon) — owns process exit via
  // daemonProcessMain so a live timer can't linger a finished daemon.
  daemonProcessMain({
    name: "drishti-agent",
    run: async () => {
      const reader = createProcReader();
      log(
        `drishti-agent daemon: os=${reader.os}, pid=${process.pid}, home=${home.dir}`,
      );

      const drainSignal = new AbortController();
      const runtime = await buildAgentRuntime(reader, {
        ringPath: home.file(HISTORY_RING_FILE),
        stateRoot: home.dir,
        withControlCore: true,
        onDrain: () => {
          log("control-core drain — flushing ring and aborting lifetime");
          drainSignal.abort();
        },
      });

      try {
        return await daemonMain({
          home,
          router: runtime.router,
          lifetime: {
            kind: "idleTimeout",
            ms: IDLE_TIMEOUT_MS,
            isIdle: runtime.isIdle,
          },
          log: stderrLogger(),
          signal: drainSignal.signal,
          onReady: ({ socketPath, pid }) =>
            log(`listening on ${socketPath} (pid ${pid})`),
        });
      } finally {
        await runtime.close();
      }
    },
  });
}

// Guard the entrypoint so importing this module (e.g. from main.test.ts to
// exercise `serveAgent` / `buildAgentRuntime` directly) doesn't spawn the agent.
if (import.meta.main) {
  main().catch((err) => {
    log(`fatal: ${(err as Error).message}\n${(err as Error).stack ?? ""}`);
    process.exit(1);
  });
}
