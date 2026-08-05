/**
 * The `--stdio` front shared by the two contract-skew fixtures.
 *
 * It is the PRODUCTION front, verbatim — same converge, same policy, same
 * banner. That it needs no fixture-specific behaviour at all is the point, and
 * a small proof that the layering is right: the front answers only the epoch
 * question, and a fixture daemon advertising `0.9.0` or `9.9.9` answers `hello`
 * exactly like any other, so the front reads its identity, finds it in-epoch,
 * greets `ready` and relays. The contract disagreement travels on to the
 * parent's `convergeAdmit`, which is what these fixtures exist to exercise.
 *
 * Had the front adjudicated skew itself, these fixtures would be unreachable:
 * the front would refuse before the parent ever saw the resident.
 *
 * The only thing not shared with `main.ts` is the log label, so a fixture's
 * trail stays attributable in `agent.stderr.log`.
 */

import {
  daemonHome,
  frontDaemonOverStdio,
  readBakedIdentity,
  reExecAsDetachedDaemon,
} from "@kolu/surface-daemon";
import { writeStdioReadiness } from "@kolu/surface/links/readiness";
import { Effect } from "effect";
import { convergeAgentStdioFront } from "../convergeFront";

export interface SkewFixtureFrontOptions {
  /** The fixture's rendezvous — the same `daemonHome` its daemon binds. */
  readonly home: ReturnType<typeof daemonHome>;
  /** stderr log prefix, so a fixture's trail is attributable. */
  readonly label: string;
}

/** Converge, greet, relay — the production order. */
export async function runSkewFixtureFront(
  opts: SkewFixtureFrontOptions,
): Promise<void> {
  const { home, label } = opts;
  const verdict = await Effect.runPromise(
    convergeAgentStdioFront({
      home,
      stderrLog: home.file("agent.stderr.log"),
      buildId: readBakedIdentity("DRISHTI_AGENT").staleKey,
    }),
  );
  writeStdioReadiness(process.stdout, verdict);
  if (verdict.verdict === "refused") {
    process.stderr.write(`[${label}] refusing to relay — ${verdict.detail}\n`);
    process.exit(1);
  }
  await frontDaemonOverStdio({
    socketPath: home.socketPath,
    spawnDaemon: () =>
      reExecAsDetachedDaemon({
        stripArgs: ["--stdio"],
        stderrLog: home.file("agent.stderr.log"),
      }),
    log: (msg) => process.stderr.write(`[${label}] ${msg}\n`),
  });
}
