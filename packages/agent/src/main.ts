/**
 * drishti-agent entrypoint.
 *
 * Modes:
 *   --stdio                   serve the surface over stdin/stdout (the
 *                             headline path; what `ssh $host $agent
 *                             --stdio` invokes).
 *   --broken-stdout-log       deliberately log a stray line to stdout
 *                             before any RPC. The parent's client peer
 *                             sees garbage and surfaces a frame-parse
 *                             failure rather than hanging. Smoke-test
 *                             only; not for production.
 *   (no args)                 print usage to stderr and exit 1.
 *
 * The agent polls `proc` and `system` every `POLL_INTERVAL_MS` and
 * pushes deltas through the surface's typed `ctx` — the framework
 * mutates the snapshot AND publishes per-key updates in one call. New
 * subscribers see a full snapshot as their first yield
 * (snapshot-then-delta invariant) and per-PID upserts/removes
 * thereafter.
 *
 * **Stdout is the protocol channel.** All logging goes to fd 2
 * (`process.stderr.write`). `serveOverStdio` defensively redirects
 * `console.log` to stderr too, but this module avoids `console.log`
 * entirely for clarity.
 */

import { implement } from "@orpc/server";
import {
  implementSurface,
  inMemoryChannel,
  inMemoryChannelByName,
  inMemoryStore,
} from "@kolu/surface/server";
import { serveOverStdio } from "@kolu/surface/peer-server";
// The reactive bridge (kolu W5, phase 0). This import is CORRECT here and only
// here: the agent is the surface's serving endpoint, so folding host metrics
// into the `alerts` cell through a backend signal graph belongs in the agent's
// main.ts. It must NOT reach the agent-SHARED graph (`drishti-common`) — the
// agent-boots CI check guards exactly that — so the pure fold lives in
// `drishti-common/alerts` (reactor-free) and the graph that DRIVES it lives
// here.
import { derived, scan, source } from "@kolu/surface/reactor";
import {
  type CoreId,
  type CpuCore,
  type IfaceName,
  type MetricHistoryMsg,
  type NetInterface,
  type Pid,
  type Process,
  type ProcessesSnapshotMsg,
  surface,
} from "drishti-common";
import {
  applyHysteresis,
  type MetricsFrame,
  NO_ALERTS,
} from "drishti-common/alerts";
import { averageCoreUsage, metricPercents } from "drishti-common/metrics";
import { createProcReader, type ProcReader } from "./proc";

const POLL_INTERVAL_MS = 2000;

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

function usage(): never {
  process.stderr.write(
    [
      "drishti-agent — exposes /proc or sysctl as a typed @kolu/surface over stdio.",
      "",
      "Usage:",
      "  drishti-agent --stdio                # serve over stdin/stdout (normal mode)",
      "  drishti-agent --stdio --broken-stdout-log",
      "                                        # stdout corruption smoke test",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// The mutable per-tick fields of `Process` — the ones whose change must
// re-publish a row. All of these can shift over a process's life; `startedAtMs`
// cannot (a process can't change when it started — immutable per pid), so it is
// deliberately absent, which also keeps it out of the publish gate regardless
// of how the agent derives it. Listing membership explicitly (rather than a
// hand-maintained OR-chain, which had already silently dropped `user`) keeps it
// exhaustively reviewable, and `satisfies` ties each entry to a real schema
// field so a typo or renamed field fails to compile.
const MUTABLE_PROCESS_FIELDS = [
  "user",
  "cpuPct",
  "rssBytes",
  "command",
  "cwd",
  "ppid",
  "state",
  "nice",
  "threads",
] as const satisfies readonly (keyof Process)[];

// Whether a process's wire-visible state changed since the last poll — the
// gate for re-publishing a row.
function processChanged(a: Process, b: Process): boolean {
  return MUTABLE_PROCESS_FIELDS.some((f) => a[f] !== b[f]);
}

/** The serve operation `serveAgent` calls — narrowed to the one shape it
 *  uses, so a test can inject a fake (the default is the real stdio
 *  transport, which is assignable to this). Module-private and named for the
 *  *role*, not the `serveOverStdio` implementation: nothing outside this file
 *  consumes it, and the test passes an inline, contextually-typed fake.
 *  Resolves to `unknown` because the agent only awaits serving's *end*, not
 *  its value: the real `serveOverStdio` settles with a `ServeOverStdioEnd`
 *  (`{ reason: "end" | "error" }` — it never rejects on a peer transport
 *  death), while a test fake may simply resolve void. */
type Serve = (opts: {
  // biome-ignore lint/suspicious/noExplicitAny: the kolu handler's router type; the real serveOverStdio is invoked with the same `as any` cast at the call site below.
  router: any;
  onFirstRequest: () => void;
}) => Promise<unknown>;

/**
 * Build the surface fragment + poll loop for `reader`, then serve it.
 *
 * **Serve before you enumerate.** The connect handshake — the parent's first
 * `system.get` — needs only the cheap `system` snapshot, so that is the one
 * read we seed before serving. The expensive process scan (darwin: `ps` +
 * `lsof -nP -d cwd` over the *whole* table) and network read (`netstat`) are
 * NOT on the handshake's critical path: they start empty and the poll loop
 * fills them. `await`-ing them before `serve` is what let a busy,
 * high-process-count host (a loaded macOS box as `localhost`, say) blow the
 * parent's 30s connect watchdog — "transport up, no first RPC" — while the
 * link itself was fine. See docs/plans/talk-localhost-handshake-timeout.html.
 *
 * `serve` is injectable for tests; it defaults to the real stdio transport.
 */
export async function serveAgent(
  reader: ProcReader,
  serve: Serve = serveOverStdio,
): Promise<void> {
  // Per-core CPU usage is a *rate* against the previous tick; the reader
  // captured its baseline at construction, so this synchronous seed (just
  // os.cpus(), no fork) costs nothing and lets a subscriber see cores at once.
  // Seeded before `system` so its cpuPct/coreCount aggregate is live too.
  const cpuCoreSnapshot = new Map<CoreId, CpuCore>();
  for (const [core, value] of reader.readCpuCores())
    cpuCoreSnapshot.set(core, value);
  // Seed the `system` cell synchronously — the cheap read (vm_stat + statfs
  // on darwin, a couple of /proc reads on linux) the handshake actually
  // needs, so the cell is live the instant we serve.
  const systemStore = inMemoryStore({
    ...(await reader.readSystem()),
    ...cpuAggregate(cpuCoreSnapshot),
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  // Processes and network start EMPTY and are filled by the poll loop's first
  // tick (kicked immediately below), NOT awaited here. On darwin
  // `readProcesses` forks `ps` + `lsof` over every pid and `readNetwork`
  // forks `netstat`; awaiting them before serving would gate the first RPC
  // behind a full process scan — the bug this reorder fixes.
  const processSnapshot = new Map<Pid, Process>();
  const netSnapshot = new Map<IfaceName, NetInterface>();

  // Build the surface implementation. The `processes` collection's
  // `readAll` yields the current snapshot; `upsert`/`remove` are the
  // single in-process write seam — the poll loop calls
  // `fragment.ctx.collections.processes.upsert/remove`, which mutates
  // the snapshot AND publishes through the framework's keyed channels.
  // `processesSnapshot` stream subscribers read the current map on
  // first subscribe, then forward every delta the poll loop publishes.
  const snapshotDeltaBus = inMemoryChannel<ProcessesSnapshotMsg>();

  // The metrics SOURCE feeding the `alerts` reactor graph. The poll `tick`
  // pushes one `MetricsFrame` per tick through `emitMetrics`; `scan` folds each
  // occurrence into the raised-alert set via the pure `applyHysteresis`, and
  // `derived.cell` publishes that level as the wire-read-only `alerts` cell (its
  // own `equals` gate, `alertsEqual`, is the wire dedup). No store: `alerts`
  // must NOT survive a restart — a fresh process re-derives its level from fresh
  // samples. `emitMetrics` is installed SYNCHRONOUSLY the moment `scan(metrics,
  // …)` below subscribes to this source — that happens while the `cells` literal
  // is evaluated to build `implementSurface`'s argument, BEFORE the runtime ever
  // fires the `derived.cell` connect effect. It goes null again only when that
  // scan/source subscription tears down at dispose. So the poll's `?.` guard
  // covers the pre-construction / post-teardown window, not a pre-connect gap.
  let emitMetrics: ((f: MetricsFrame) => void) | null = null;
  const metrics = source<MetricsFrame>((emit) => {
    emitMetrics = emit;
    return () => {
      emitMetrics = null;
    };
  });

  const fragment = implementSurface(surface, {
    channel: inMemoryChannelByName(),
    cells: {
      // The agent serves the connection-FREE base surface. Link health is the
      // PARENT's observation of the parent↔agent link (the agent can't see its
      // own SSH transport from the inside), so it's composed only at the parent's
      // re-serve via `mirroredSurface`, never here.
      system: { store: systemStore },
      // The reactor's wire exit: `alerts` is a DERIVED cell — the graph is its
      // only writer. `scan(metrics, NO_ALERTS, applyHysteresis)` folds the
      // metrics source into the raised-alert set; `derived.cell` plugs into the
      // existing cell connect seam ({ store, connect }) and is branded so the
      // boot walk enforces the contract's get-only verbs.
      alerts: derived.cell(scan(metrics, NO_ALERTS, applyHysteresis)),
    },
    collections: {
      processes: {
        readAll: () => processSnapshot,
        upsert: (key, value) => {
          processSnapshot.set(key, value);
        },
        remove: (key) => {
          processSnapshot.delete(key);
        },
      },
      cpuCores: {
        readAll: () => cpuCoreSnapshot,
        upsert: (key, value) => {
          cpuCoreSnapshot.set(key, value);
        },
        remove: (key) => {
          cpuCoreSnapshot.delete(key);
        },
      },
      networkInterfaces: {
        readAll: () => netSnapshot,
        upsert: (key, value) => {
          netSnapshot.set(key, value);
        },
        remove: (key) => {
          netSnapshot.delete(key);
        },
      },
    },
    streams: {
      processesSnapshot: {
        source: async function* (_input, signal) {
          yield {
            kind: "snapshot",
            entries: [...processSnapshot.entries()],
          } satisfies ProcessesSnapshotMsg;
          for await (const delta of snapshotDeltaBus.subscribe(signal)) {
            yield delta;
          }
        },
      },
      // ⚠ **INERT STUB — the agent keeps no history.** Declared on the
      // shared surface so the browser can subscribe; the parent is the
      // authoritative source (see router.ts). A direct-to-agent client sees
      // an empty, never-updating history — by design, like `connection`.
      // After the empty snapshot it parks until the subscriber leaves —
      // never an active transport, so there's no channel to allocate.
      metricHistory: {
        source: async function* (_input, signal) {
          yield { kind: "snapshot", samples: [] } satisfies MetricHistoryMsg;
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    },
    // The one PROCEDURE on this surface — `kill` runs HERE, on the host that owns
    // the pids (the parent has none; it forwards through the mirror's stub, kolu
    // #1505 R7). `process.kill` raising (ESRCH gone, EPERM not permitted) is a
    // normal, reportable outcome, not a crash — caught and returned as
    // `{ ok: false, error }` so the browser can surface it.
    procedures: {
      process: {
        kill: ({ input }) => {
          try {
            process.kill(input.pid, `SIG${input.signal}`);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: (err as Error).message };
          }
        },
      },
    },
  });

  // Assert the eager-subscribe invariant the `emitMetrics` comment above rests
  // on: `scan(metrics, …)` subscribed to the source while the `cells` literal
  // was evaluated, so `emitMetrics` is installed by now. If a future reactor
  // change made that subscription lazy (deferred to the `derived.cell` connect),
  // `emitMetrics` would be null here and every poll tick's `?.` would silently
  // no-op FOREVER — a host that never raises an alert, with no crash and no log.
  // Fail LOUD at boot instead: a one-time check that turns a silent-forever
  // regression into an immediate, obvious agent-startup crash (drishti CI's e2e
  // would go red on the first boot). The `?.` at the tick's call site then means
  // exactly one thing — a late tick after dispose — not "maybe never installed".
  if (emitMetrics === null)
    throw new Error(
      "alerts reactor: metrics source was never subscribed during surface " +
        "construction — the scan→source eager-subscribe invariant broke",
    );

  // Poll loop: refresh system + processes, diff against current
  // `processSnapshot`, push deltas through the framework's ctx (which
  // mutates the snapshot AND publishes to subscribers in one step).
  const tick = async (): Promise<void> => {
    try {
      const [nextSystem, nextProcesses, nextNet] = await Promise.all([
        reader.readSystem(),
        reader.readProcesses(),
        reader.readNetwork(),
      ]);
      // Read per-core usage up front so the host-CPU aggregate (cpuPct /
      // coreCount) rides this tick's `system` cell — the fleet card reads that
      // one scalar instead of subscribing to all N per-core cells to average
      // them (the O(hosts×cores) fan-out the fleet used to pay).
      const nextCores = reader.readCpuCores();
      const sys = {
        ...nextSystem,
        ...cpuAggregate(nextCores),
        pollIntervalMs: POLL_INTERVAL_MS,
      };
      fragment.ctx.cells.system.set(sys);
      // Feed the alert reactor the frame just composed. `emitMetrics` was
      // installed synchronously when `scan` subscribed to the source at
      // construction (see above), so by the time this poll runs it is already
      // live; it is null only after the scan/source subscription tears down at
      // dispose, where the `?.` makes a late tick a harmless no-op.
      emitMetrics?.(metricPercents(sys));
      const upserts: Array<[Pid, Process]> = [];
      const removes: Pid[] = [];
      for (const [pid, value] of nextProcesses) {
        const prev = processSnapshot.get(pid);
        if (prev === undefined || processChanged(prev, value)) {
          fragment.ctx.collections.processes.upsert(pid, value);
          upserts.push([pid, value]);
        }
      }
      for (const pid of processSnapshot.keys()) {
        if (!nextProcesses.has(pid)) {
          fragment.ctx.collections.processes.remove(pid);
          removes.push(pid);
        }
      }
      if (upserts.length > 0 || removes.length > 0) {
        snapshotDeltaBus.publish({ kind: "delta", upserts, removes });
      }

      // Per-core CPU usage — published through the framework's
      // Collection<K,T>. Small-N (4-32 cores) so per-key fan-out is the right
      // shape for the host drill-in, where each core gets its own reactive bar;
      // the fleet glance card reads the `system.cpuPct` aggregate above instead
      // of subscribing here. `nextCores` was read above for that aggregate.
      // Evict cores that disappeared (hot-unplug / VM CPU resize) so stale bars
      // don't linger in the browser strip.
      for (const [core, value] of nextCores) {
        fragment.ctx.collections.cpuCores.upsert(core, value);
      }
      for (const core of cpuCoreSnapshot.keys()) {
        if (!nextCores.has(core))
          fragment.ctx.collections.cpuCores.remove(core);
      }

      // Per-NIC network I/O — same Collection<K,T> publish shape as
      // cpuCores. Throughput shifts almost every tick, so unconditional
      // upserts are simplest; evict interfaces that vanished (NIC down /
      // hot-unplug) so stale rows don't linger in the browser. `nextNet`
      // is read in the tick-top Promise.all — an independent forked probe
      // (darwin `netstat`), so it rides alongside system/processes rather
      // than adding a serial leg to every tick's latency.
      for (const [iface, value] of nextNet) {
        fragment.ctx.collections.networkInterfaces.upsert(iface, value);
      }
      for (const iface of netSnapshot.keys()) {
        if (!nextNet.has(iface))
          fragment.ctx.collections.networkInterfaces.remove(iface);
      }
    } catch (err) {
      log(`tick error: ${(err as Error).message}`);
    }
  };
  const interval = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  // Kick the first enumeration immediately and fire-and-forget, so processes
  // and network populate within one scan rather than after a full poll
  // interval — but off the serving critical path, so the handshake still
  // roundtrips now. (The broken-stdout smoke test writes to fd 1 in `main`,
  // before we ever serve.)
  void tick();

  // `implementSurface` returns a fragment with shape `{ surface: ... }`;
  // passing it straight to `serveOverStdio`'s `StandardRPCHandler`
  // double-wraps the path (`/surface/surface/...`) and every client
  // request 404s. Wrap once via `implement(contract).router(...)` to
  // flatten the prefix.
  const router = implement(surface.contract).router({ ...fragment.router });

  log("serving surface over stdio (read=stdin, write=stdout)");
  // Heartbeat while blocked on the first request. A healthy connect
  // roundtrips sub-second; if this keeps ticking up to ~30s the parent's
  // connect watchdog is about to kill us — and these lines (forwarded to
  // the parent's log) show the agent was alive and waiting the whole time,
  // pinning the stall on the parent→agent handshake rather than the remote.
  const servingSince = Date.now();
  const waitingHeartbeat = setInterval(() => {
    log(
      `waiting for first RPC (${Math.round((Date.now() - servingSince) / 1000)}s)…`,
    );
  }, 5000);
  await serve({
    // biome-ignore lint/suspicious/noExplicitAny: implementSurface's Lazy<Router> spread isn't accepted by oRPC's Router<any, T> input type; runtime shape is valid.
    router: router as any,
    onFirstRequest: () => {
      clearInterval(waitingHeartbeat);
      log(`first RPC received — link is live (pid=${process.pid})`);
    },
  });
  clearInterval(waitingHeartbeat);
  clearInterval(interval);
  log("stdin closed — agent exiting");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--stdio")) usage();
  const brokenStdoutLog = args.includes("--broken-stdout-log");

  const reader = createProcReader();
  log(`drishti-agent: os=${reader.os}, pid=${process.pid}`);

  // Deliberately broken variant — bypass console.log redirection and write
  // directly to fd 1, before any RPC. This is exactly the wire-corrupting bug
  // `serveOverStdio` documents: the parent's client peer sees garbage and
  // surfaces a frame-parse failure rather than hanging. Smoke-test only.
  if (brokenStdoutLog) {
    process.stdout.write("DEBUG: this line corrupts the protocol channel\n");
  }

  await serveAgent(reader);
}

// Guard the entrypoint so importing this module (e.g. from main.test.ts to
// exercise `serveAgent` directly) doesn't spawn the agent. Mirrors build.ts.
if (import.meta.main) {
  main().catch((err) => {
    log(`fatal: ${(err as Error).message}\n${(err as Error).stack ?? ""}`);
    process.exit(1);
  });
}
