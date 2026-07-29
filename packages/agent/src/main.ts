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
  daemonHome,
  daemonMain,
  daemonProcessMain,
  frontDaemonOverStdio,
  reExecAsDetachedDaemon,
  stderrLogger,
} from "@kolu/surface-daemon";
import { HISTORY_RING_FILE } from "./historyRing";
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
  // biome-ignore lint/suspicious/noExplicitAny: the kolu handler's router type.
  router: any;
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
