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

import { implementSurface, inMemoryStore } from "@kolu/surface/server";
import { serveOverStdio } from "@kolu/surface/peer-server";
// The reactive bridge (kolu W5, phase 0). This import is CORRECT here and only
// here: the agent is the surface's serving endpoint, so folding host metrics
// into the `alerts` cell through a backend signal graph belongs in the agent's
// main.ts. It must NOT reach the agent-SHARED graph (`drishti-common`) — the
// agent-boots CI check guards exactly that — so the pure fold lives in
// `drishti-common/alerts` (reactor-free) and the graph that DRIVES it lives
// here.
import { derived, scan, source } from "@kolu/surface/reactor";
import { type CoreId, type CpuCore, surface } from "drishti-common";
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

/** Wrap an async tick so a fire that lands while a previous run is still in
 *  flight is SKIPPED — the same non-overlap law the framework's poll source
 *  applies to the three collections (and the cwd enricher applies to its lsof
 *  child), owned here for the one hand-rolled `setInterval` left in the agent:
 *  the system/alerts tick. Without it a slow `readSystem` (darwin: `vm_stat` +
 *  `sysctl` children) overlaps itself every 2s on a wedged host — the
 *  drishti#111 pileup class, just with cheaper children. Skipping (not
 *  queueing) is correct for a poll: the next interval fire re-samples.
 *
 *  SOUND ONLY BECAUSE THE READS SETTLE: the guard releases in `finally`, so a
 *  never-settling tick would freeze the cell forever — which is why every
 *  darwin child under this tick rides proc.ts's `CHILD_EXEC_OPTS` kill
 *  budget (a hung vm_stat settles as a rejection, the catch below logs it,
 *  and the next fire re-samples), and why the one timeout-less syscall in
 *  the tick — `statfs` — is decoupled behind proc.ts's probe-cache
 *  (`readRootDiskUsage` serves a cached observation synchronously; a
 *  D-state root fs cannot hold the tick). Exported for main.test.ts. */
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

// (The per-tick change gate for a process row — the old `MUTABLE_PROCESS_FIELDS` /
// `processChanged` — moved to the `processes` collection spec's `equals` in
// `drishti-common/surface`, since the framework's `derived.collection` reconciler
// now owns the per-key diff instead of the hand loop doing it at the write site.)

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
 * Build the surface runtime + poll loop for `reader`, then serve it.
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
  // Seed the `system` cell synchronously — the cheap read (vm_stat + statfs
  // on darwin, a couple of /proc reads on linux) the handshake actually needs, so
  // the cell is live the instant we serve. The per-core aggregate rides a fresh
  // synchronous `readCpuCores()` (just os.cpus(), no fork). The `cpuCores`
  // collection is its OWN `derived.collection` poll now (below), so there is no
  // shared snapshot Map to seed — the reconciler owns the per-core map.
  const systemStore = inMemoryStore({
    ...(await reader.readSystem()),
    ...cpuAggregate(reader.readCpuCores()),
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  // The three keyed collections (processes, cpuCores, networkInterfaces) are
  // `derived.collection(source({ read, install }))` below — the reactor owns the
  // poll loop, the keyed reconcile (diff-by-`equals`, evict-absent), and the T+0
  // seed. `processes`/`networkInterfaces` still start EMPTY and fill on the async
  // seed read (off the serving critical path — `read` runs async, so awaiting a
  // full `ps`+`lsof` scan never gates the first RPC), exactly as the hand loop did.
  const pollInstall = (tick: () => void): (() => void) => {
    const iv = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(iv);
  };

  // Build the surface implementation. The `processes` collection's `readAll`
  // yields the current snapshot; `upsert`/`remove` are the single in-process write
  // seam — the poll loop calls `runtime.ctx.collections.processes.upsert/remove`,
  // which mutates the snapshot AND publishes through the framework's channels. The
  // collection declares the `deltas` verb (surface.ts), so `@kolu/surface` coalesces
  // those per-key writes into ONE snapshot-then-delta stream the browser subscribes
  // to (SR5 — one protocol across the wire); no hand-rolled parallel bus here.

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

  const runtime = implementSurface(surface, {
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
      // The three keyed poll-reconciles, now the framework's `derived.collection`
      // over a poll `source`: each frame's whole-map read is diffed against the last
      // by the collection's `equals` (per-key upsert for a moved value, evict for an
      // absent key) — the "most-repeated hand-roll in both trees" (kolu SR8), gone.
      // The reactor owns the T+0 seed, the poll cadence, and the reconcile; the graph
      // is the one writer, so there is no ctx `upsert`/`remove` seam here.
      processes: derived.collection(
        source({ read: () => reader.readProcesses(), install: pollInstall }),
      ),
      cpuCores: derived.collection(
        source({
          // `readCpuCores` is synchronous (os.cpus()); the poll shape wants a promise.
          read: () => Promise.resolve(reader.readCpuCores()),
          install: pollInstall,
        }),
      ),
      networkInterfaces: derived.collection(
        source({ read: () => reader.readNetwork(), install: pollInstall }),
      ),
    },
    // No `streams`: the whole-process-set protocol is the `processes` collection's
    // `deltas` verb now (framework-served), and `metricHistory` moved to the parent
    // as local policy (composed via `extendSurface`) — its inert agent-side stub is gone.
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

  // Fail LOUD on an owned runtime fault. The one real producer of this today:
  // a collection poll's SEED read rejecting — e.g. a kill-budget-expired `ps`
  // on a host already wedged at boot — which the framework's poll-read
  // contract makes PERMANENTLY fatal to that collection (cadence torn down,
  // no retry; only LATER ticks are log-skip-continue). A live agent silently
  // serving a dead processes table for its whole life is the worst outcome —
  // exit non-zero instead, so the parent surfaces agent death in the
  // connection cell where the user actually looks, and a reconnect gets a
  // fresh seed attempt. (Deliberately NOT made total at the reader: catching
  // a seed `ps` failure into an empty map would render a healthy-looking
  // empty table over a broken platform — a silent lie.)
  void runtime.done.catch((err: unknown) => {
    log(`surface runtime fault: ${(err as Error).message} — exiting`);
    process.exit(1);
  });

  // Poll loop for the `system` cell + the `alerts` reactor ONLY: read the cheap
  // host scalars + the per-core aggregate, publish `system`, and feed the metrics
  // source. The three keyed COLLECTIONS are `derived.collection` polls of their own
  // now (above) — the framework owns their reconcile — so the hand-held
  // upsert/remove loops (and the snapshot Maps + `processChanged`) are gone.
  const tick = singleFlight(async (): Promise<void> => {
    try {
      const nextSystem = await reader.readSystem();
      // Per-core usage for the host-CPU aggregate (cpuPct / coreCount) on the
      // `system` cell — the fleet card reads that one scalar instead of subscribing
      // to all N per-core cells (the O(hosts×cores) fan-out). Read here as well as
      // in the `cpuCores` collection poll: `readCpuCores` is a cheap synchronous
      // os.cpus() delta, so the fleet scalar and the per-core bars each take a read.
      const sys = {
        ...nextSystem,
        ...cpuAggregate(reader.readCpuCores()),
        pollIntervalMs: POLL_INTERVAL_MS,
      };
      runtime.ctx.cells.system.set(sys);
      // Feed the alert reactor the frame just composed. `emitMetrics` was installed
      // synchronously when `scan` subscribed to the source at construction (see
      // above), so by the time this poll runs it is already live; null only after
      // dispose, where the `?.` makes a late tick a harmless no-op.
      emitMetrics?.(metricPercents(sys));
    } catch (err) {
      log(`tick error: ${(err as Error).message}`);
    }
  });
  const interval = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  // Kick the system/alerts read immediately (off the serving critical path so the
  // handshake still roundtrips now). The three collection polls kick their own T+0
  // seed read through the reactor.
  void tick();

  // `implementSurface` returns a supervised runtime whose `.router` is the
  // FINAL top-level router — hand it straight to `serveOverStdio`, no re-wrap.
  const router = runtime.router;

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
  // Synchronous post-settle cleanup — the supported window before the
  // FRAMEWORK-OWNED exit: since kolu#1858, `serveOverStdio` on the default
  // transport exits this process itself once the serve promise settles
  // (0 on a clean end, 1 on a transport error), so a live handle (the
  // reactor's collection polls, this poll interval) can no longer keep a
  // dead agent alive — the drishti#109 orphan is unspellable, inherited
  // from the framework rather than hand-rolled here. These synchronous
  // lines run before that exit; the injected test fake keeps caller-owned
  // lifetime, so tests are unaffected.
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
