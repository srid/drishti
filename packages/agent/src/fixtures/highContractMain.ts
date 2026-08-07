/**
 * Test-only process entry: durable agent daemon whose control-core hello
 * advertises surfaceVersion "9.9.9" so the parent's contract-newer refuse arm
 * is exercised end-to-end.
 *
 * W7.2: version injection uses the module-private surfaceVersionOverride
 * seam on ./runtime (same class as ringPersistMs) — NEVER ambient env,
 * NEVER a package-public export. Fixture imports the private runtime module
 * directly (not via main).
 *
 * Spawn: `bun packages/agent/src/fixtures/highContractMain.ts --stdio`
 * reExecAsDetachedDaemon re-invokes this file without --stdio for the
 * gate-held daemon.
 */

import {
  daemonHome,
  daemonMain,
  daemonProcessMain,
  stderrLogger,
} from "@kolu/surface-daemon";
import {
  readProcessIdentity,
  selfProcessIdentity,
} from "../processIdentity";
import { HISTORY_RING_FILE } from "../historyRing";
import { createProcReader } from "../proc";
import { buildAgentRuntime } from "../runtime";
import { runSkewFixtureFront } from "./skewFront";

const HIGH_CONTRACT_VERSION = "9.9.9";
const IDLE_TIMEOUT_MS = 60 * 60_000;

function log(msg: string): void {
  process.stderr.write(`[high-contract-fixture] ${msg}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantStdio = args.includes("--stdio");
  const home = daemonHome({ app: "drishti", placement: "state" });

  if (wantStdio) {
    log(`fronting daemon at ${home.socketPath}`);
    await runSkewFixtureFront({
      home,
      label: "high-contract-fixture",
    });
    return;
  }

  daemonProcessMain({
    name: "drishti-agent-high-contract-fixture",
    run: async () => {
      const reader = createProcReader();
      log(
        `daemon: os=${reader.os}, pid=${process.pid}, surfaceVersion=${HIGH_CONTRACT_VERSION}`,
      );
      const drainSignal = new AbortController();
      const runtime = await buildAgentRuntime(reader, {
        ringPath: home.file(HISTORY_RING_FILE),
        stateRoot: home.dir,
        withControlCore: true,
        surfaceVersionOverride: HIGH_CONTRACT_VERSION,
        onDrain: () => {
          drainSignal.abort();
        },
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

if (import.meta.main) {
  main().catch((err) => {
    log(`fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
