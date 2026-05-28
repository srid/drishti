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
import {
  type CoreId,
  type CpuCore,
  DEFAULT_CONNECTION,
  type Pid,
  type Process,
  type ProcessesSnapshotMsg,
  surface,
} from "../common/surface";
import { createProcReader } from "./proc";

const POLL_INTERVAL_MS = 2000;

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--stdio")) usage();
  const brokenStdoutLog = args.includes("--broken-stdout-log");

  const reader = createProcReader();
  log(`drishti-agent: os=${reader.os}, pid=${process.pid}`);

  const systemStore = inMemoryStore({
    ...(await reader.readSystem()),
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  const processSnapshot = new Map<Pid, Process>();
  for (const [pid, value] of await reader.readProcesses())
    processSnapshot.set(pid, value);
  // Seed CPU-core baseline so the first delta has a previous tick to
  // compare against — first call returns mostly-zero usages.
  const cpuCoreSnapshot = new Map<CoreId, CpuCore>();
  for (const [core, value] of reader.readCpuCores())
    cpuCoreSnapshot.set(core, value);

  // Build the surface implementation. The `processes` collection's
  // `readAll` yields the current snapshot; `upsert`/`remove` are the
  // single in-process write seam — the poll loop calls
  // `fragment.ctx.collections.processes.upsert/remove`, which mutates
  // the snapshot AND publishes through the framework's keyed channels.
  // `processesSnapshot` stream subscribers read the current map on
  // first subscribe, then forward every delta the poll loop publishes.
  const snapshotDeltaBus = inMemoryChannel<ProcessesSnapshotMsg>();
  const fragment = implementSurface(surface, {
    channel: inMemoryChannelByName(),
    cells: {
      system: { store: systemStore },
      // ⚠ **INERT STUB — DO NOT WRITE TO THIS CELL.**
      // `connection` is declared on the shared surface so the browser
      // can subscribe to parent-published lifecycle. The agent has no
      // visibility into its own SSH transport state from the inside,
      // so this store stays at `DEFAULT_CONNECTION` for the lifetime
      // of the process. The parent's router has independent write
      // authority on its own implementation of the same surface.
      // (See the warning in common/surface.ts on `ConnectionSchema`.)
      connection: { store: inMemoryStore({ ...DEFAULT_CONNECTION }) },
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
    },
    procedures: {
      process: {
        kill: async ({ input }) => {
          try {
            process.kill(input.pid, input.signal);
            return { ok: true };
          } catch (err) {
            log(
              `kill ${input.pid} ${input.signal} failed: ${(err as Error).message}`,
            );
            return { ok: false };
          }
        },
      },
    },
  });

  // Poll loop: refresh system + processes, diff against current
  // `processSnapshot`, push deltas through the framework's ctx (which
  // mutates the snapshot AND publishes to subscribers in one step).
  const tick = async (): Promise<void> => {
    try {
      const [nextSystem, nextProcesses] = await Promise.all([
        reader.readSystem(),
        reader.readProcesses(),
      ]);
      fragment.ctx.cells.system.set({
        ...nextSystem,
        pollIntervalMs: POLL_INTERVAL_MS,
      });
      const upserts: Array<[Pid, Process]> = [];
      const removes: Pid[] = [];
      for (const [pid, value] of nextProcesses) {
        const prev = processSnapshot.get(pid);
        if (
          prev === undefined ||
          prev.cpuPct !== value.cpuPct ||
          prev.memPct !== value.memPct ||
          prev.command !== value.command ||
          prev.cwd !== value.cwd
        ) {
          fragment.ctx.collections.processes.upsert(pid, value);
          upserts.push([pid, value]);
        }
      }
      for (const pid of [...processSnapshot.keys()]) {
        if (!nextProcesses.has(pid)) {
          fragment.ctx.collections.processes.remove(pid);
          removes.push(pid);
        }
      }
      if (upserts.length > 0 || removes.length > 0) {
        snapshotDeltaBus.publish({ kind: "delta", upserts, removes });
      }

      // Per-core CPU usage — published through the framework's
      // Collection<K,T>. Small-N (4-32 cores) so per-key fan-out is
      // exactly the right shape: each core gets its own reactive
      // subscription in the browser.
      // Evict cores that disappeared (hot-unplug / VM CPU resize) so
      // stale bars don't linger in the browser strip.
      const nextCores = reader.readCpuCores();
      for (const [core, value] of nextCores) {
        fragment.ctx.collections.cpuCores.upsert(core, value);
      }
      for (const core of cpuCoreSnapshot.keys()) {
        if (!nextCores.has(core))
          fragment.ctx.collections.cpuCores.remove(core);
      }
    } catch (err) {
      log(`tick error: ${(err as Error).message}`);
    }
  };
  const interval = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);

  // Deliberately broken variant — bypass console.log redirection and
  // write directly to fd 1. This is exactly the wire-corrupting bug
  // `serveOverStdio` documents.
  if (brokenStdoutLog) {
    process.stdout.write(
      "DEBUG: this line corrupts the protocol channel\n",
    );
  }

  // `implementSurface` returns a fragment with shape `{ surface: ... }`;
  // passing it straight to `serveOverStdio`'s `StandardRPCHandler`
  // double-wraps the path (`/surface/surface/...`) and every client
  // request 404s. Wrap once via `implement(contract).router(...)` to
  // flatten the prefix.
  const router = implement(surface.contract).router({ ...fragment.router });

  log("serving surface over stdio (read=stdin, write=stdout)");
  await serveOverStdio({
    // biome-ignore lint/suspicious/noExplicitAny: implementSurface's Lazy<Router> spread isn't accepted by oRPC's Router<any, T> input type; runtime shape is valid.
    router: router as any,
    onFirstRequest: () => log("first RPC received — link is live"),
  });
  clearInterval(interval);
  log("stdin closed — agent exiting");
}

main().catch((err) => {
  log(`fatal: ${(err as Error).message}\n${(err as Error).stack ?? ""}`);
  process.exit(1);
});
