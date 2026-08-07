/**
 * The G-round's two drishti-side pins (juspay/kolu#2101 G5/G6/G9).
 *
 * Both are about a daemon that keeps ANSWERING after its insides have died —
 * the deploy-#2 zombie: alive, gate held, socket accepting, runtime dead. The
 * framework now supplies the fault channel (`DaemonSpec.faultSignal` +
 * `armRuntimeFaultExit`); these pin that drishti actually rides it, and rides
 * it through the shutdown spine rather than around it.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  exceedsFrameLimit,
  RPC_MAX_FRAME_BYTES,
} from "@kolu/surface/frame-limit";
import { HISTORY_RETENTION_MS } from "drishti-common/history";

const src = (name: string): string =>
  readFileSync(join(import.meta.dir, name), "utf-8");

/** Source with comments removed. Load-bearing: the very rationale comments that
 *  explain why the old `process.exit` is gone naturally QUOTE it, so a raw
 *  substring scan flags the explanation as the defect. Pin the code, never the
 *  prose — the alternative is a test that punishes documenting the fix. */
const code = (name: string): string =>
  src(name)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("an owned surface-runtime fault exits the daemon (G6)", () => {
  // Source pins, drishti's established idiom for a wiring invariant a type
  // cannot express. What makes them worth having is that the WRONG version of
  // this code also compiles and also "handles" the fault — the old
  // `process.exit(1)` did. The defect was never a missing handler; it was a
  // handler that skipped the teardown, so the bug is invisible to tsc and
  // visible only in the shape of the call.

  it("runtime.ts does not kill a process it does not own", () => {
    const runtime = code("runtime.ts");
    // The old line was `void built.done.catch(… process.exit(1))` inside the
    // runtime BUILDER. A library that exits bypasses the daemon's socket close
    // and gate release, so the successor meets a gate naming a dead pid and the
    // ring loses everything since the last periodic persist.
    expect(runtime).not.toMatch(/process\.exit/);
    // `done` must still be HANDED OUT — removing the exit is only correct
    // because ownership moved, not because the fault stopped mattering.
    expect(runtime).toMatch(/done:\s*built\.done/);
  });

  it("main.ts arms the fault exit and routes it through daemonMain", () => {
    const main = code("main.ts");
    expect(main).toMatch(/armRuntimeFaultExit\(\{/);
    // Armed off the runtime's own done — not some other promise.
    expect(main).toMatch(/done:\s*runtime\.done/);
    // Handed to the spine, so teardown is ordered and the exit code is scored
    // `runtime-fault` (non-zero) rather than a bare exit nobody can classify.
    expect(main).toMatch(/faultSignal,/);
  });

  it("drishti's last rites persist the history ring", () => {
    // The ring is the one piece of agent state a respawn cannot reconstruct.
    // Without this the fault path silently discards up to a full persist
    // interval of samples — which would look like a gap in the chart and
    // nothing else.
    expect(code("main.ts")).toMatch(/lastRites:\s*\(\)\s*=>\s*runtime\.flushRing\(\)/);
  });
});

describe("no drishti frame approaches the RPC cap (G9)", () => {
  // The cap is a whole-CONNECTION death sentence, not a per-call failure: an
  // oversized frame closes the socket with 1009, taking every unrelated
  // subscription on that tab with it. So the interesting number is headroom,
  // and it is asserted rather than asserted-about-in-prose.

  it("the metricHistory snapshot — drishti's largest bounded frame — has ~3 orders of magnitude of headroom", () => {
    const POLL_INTERVAL_MS = 2000; // runtime.ts
    const maxSamples = HISTORY_RETENTION_MS / POLL_INTERVAL_MS;
    // Seven numeric fields plus JSON punctuation. Deliberately generous: the
    // point is the ORDER of magnitude, and a padded per-sample estimate makes
    // the conclusion stronger, not weaker.
    const GENEROUS_BYTES_PER_SAMPLE = 160;
    const worstCase = maxSamples * GENEROUS_BYTES_PER_SAMPLE;

    expect(maxSamples).toBe(900);
    expect(exceedsFrameLimit(worstCase)).toBe(false);
    // Headroom, stated as a number so a future retention or cadence change
    // that erodes it fails HERE rather than on a user's socket.
    expect(RPC_MAX_FRAME_BYTES / worstCase).toBeGreaterThan(100);
  });
});
