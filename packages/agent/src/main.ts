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
 * **Stdout is the protocol channel in --stdio mode.** All logging goes to
 * fd 2 (`process.stderr.write`).
 */

import {
  armRuntimeFaultExit,
  daemonHome,
  daemonMain,
  daemonProcessMain,
  frontDaemonOverStdio,
  readBakedIdentity,
  reExecAsDetachedDaemon,
  stderrLogger,
} from "@kolu/surface-daemon";
import { writeStdioReadiness } from "@kolu/surface/links/readiness";
import type { SurfaceHandlers } from "@kolu/surface/server";
import { Effect } from "effect";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { convergeAgentStdioFront } from "./convergeFront";
import { HISTORY_RING_FILE } from "./historyRing";
import {
  readProcessIdentity,
  selfProcessIdentity,
} from "./processIdentity";
import { createProcReader, type ProcReader } from "./proc";
import { buildAgentRuntime, singleFlight } from "./runtime";

// Re-export singleFlight for main.test.ts (same module surface as before).
export { singleFlight };

/** Idle-exit after this many ms with no live parent connections. */
const IDLE_TIMEOUT_MS = 60 * 60_000;

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
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

/** The serve operation `serveAgent` calls — narrowed to the one shape it
 *  uses, so a test can inject a fake (the default is the real stdio
 *  transport, which is assignable to this). Module-private and named for the
 *  *role*, not a particular transport. Resolves to `unknown` because the agent
 *  only awaits serving's *end*, not its value. */
type Serve = (opts: {
  group: RpcGroup.RpcGroup<Rpc.Any>;
  handlers: SurfaceHandlers;
  onFirstRequest: () => void;
}) => Promise<unknown>;

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
    group: runtime.group,
    handlers: runtime.handlers,
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

    // ── Converge BEFORE relaying (juspay/kolu#2101) ─────────────────────────
    //
    // The convergence kit, run HERE on the box where the gate file, the pid
    // table and the signals live — the parity drishti's fleet arm shipped
    // without. Only once an agent of this epoch demonstrably holds the
    // rendezvous does the front greet and splice; a front that cannot converge
    // says so on the wire and exits.
    //
    // THE PROCESS EDGE: the kit is Effect-native all the way down and this is a
    // CLI entry whose caller is `main()`'s own `.catch`. The relay below is
    // Promise-shaped by `frontDaemonOverStdio`'s contract, so there is nothing
    // left to compose into — the crossing happens once, named, at the boundary.
    const verdict = await Effect.runPromise(
      convergeAgentStdioFront({
        home,
        stderrLog: home.file("agent.stderr.log"),
        // The front's own baked id. It is the closure ssh just provisioned, so
        // its identity IS the expectation the policy compares against.
        buildId: readBakedIdentity("DRISHTI_AGENT").staleKey,
      }),
    );
    // The banner is the FIRST protocol byte on stdout either way — written
    // while the front still owns stdout, before `relay()` takes it over, which
    // is what keeps it compatible with the byte-splice guarantee.
    writeStdioReadiness(process.stdout, verdict);
    if (verdict.verdict === "refused") {
      // Exit non-zero WITHOUT relaying. The structured evidence already went to
      // stderr from the converge itself; this line is the operator's summary.
      log(`drishti-agent --stdio: refusing to relay — ${verdict.detail}`);
      process.exit(1);
    }

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
        onDrain: (flush) => {
          if (!flush.ok) {
            log(
              `control-core drain — final flush FAILED (${flush.error}); lifetime aborts with degraded ring state visible`,
            );
          } else {
            log("control-core drain — ring flushed; aborting lifetime");
          }
          drainSignal.abort();
        },
      });

      const daemonLog = stderrLogger();

      // ── An owned surface-runtime fault exits the daemon ──────────────────
      //
      // `runtime.done` rejects on structural wiring death — a cell, a bus, a
      // reactor edge. Serving on through one produces the deploy-#2 zombie:
      // alive, gate held, socket answering, runtime dead, and the parent
      // reconnecting forever into something that will never speak again.
      //
      // This used to be a bare `process.exit(1)` inside `buildAgentRuntime`,
      // which got the verdict right and the MECHANISM wrong: it bypassed the
      // shutdown spine, so the socket and the pid gate were never released and
      // the history ring was never flushed. The successor then had to reap a
      // gate whose owner was already gone, and the ring lost everything since
      // the last periodic persist.
      //
      // Riding `faultSignal` instead means the daemon tears down in order —
      // last rites, socket closed, gate released — and `daemonExitCode` scores
      // `runtime-fault` non-zero, which is the supervisor's only channel for
      // "that was a crash, not a stop".
      const faultSignal = armRuntimeFaultExit({
        done: runtime.done,
        log: daemonLog,
        subject: "drishti agent surface runtime",
        // drishti's last rites are its history ring: the metric ring is the one
        // piece of state a respawn cannot reconstruct, so it is persisted on the
        // fault path exactly as the control-core drain persists it on the clean
        // one. A throw here is logged and does not stop the exit.
        lastRites: () => runtime.flushRing(),
      });

      try {
        return await daemonMain({
          home,
          processIdentity: selfProcessIdentity(),
          readProcessIdentity,
          group: runtime.group,
          handlers: runtime.handlers,
          lifetime: {
            kind: "idleTimeout",
            ms: IDLE_TIMEOUT_MS,
            isIdle: runtime.isIdle,
          },
          log: daemonLog,
          signal: drainSignal.signal,
          faultSignal,
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
    // Stable fatal prefix for the parent's boot-refusal classifier (UI phase):
    // the stdio front / session log must carry this EXACT prefix so a terminal
    // misconfiguration (e.g. daemonHome non-0700) is never retried as "host
    // unreachable". Message after the prefix is the daemonHome text verbatim.
    const msg = (err as Error).message;
    process.stderr.write(`drishti-agent: fatal: ${msg}\n`);
    const stack = (err as Error).stack;
    if (stack !== undefined && stack.length > 0) {
      process.stderr.write(`${stack}\n`);
    }
    process.exit(1);
  });
}
