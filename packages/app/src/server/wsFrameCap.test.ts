/**
 * The frame cap, at the layer that is allowed to refuse.
 *
 * The bug: `main.ts` capped websocket messages at 8 MiB while
 * `@kolu/surface`'s `frameLimit` classifies oversize at 16 MiB. Everything in
 * between — a large process census on a busy host is the realistic one — was
 * refused by the raw `ws` layer, which has no classifier and no vocabulary for
 * it. Since every configured host's telemetry is key-folded onto ONE socket,
 * that refusal kills the whole fleet view instead of running the framework's
 * handled oversize path.
 *
 * These are tests of the NUMBER, on purpose. Bun's built-in `ws` — what this
 * server actually runs on — ignores `maxPayload` entirely and enforces 16 MiB
 * of its own, so the disagreement between the two layers was invisible from
 * the outside here and a behavioural assertion would have passed against the
 * bug. What was wrong was the configuration, so that is what is pinned: this
 * fails against `8 * 1024 * 1024` and against any future edit that lets the
 * layers drift apart again.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  exceedsFrameLimit,
  RPC_MAX_FRAME_BYTES,
} from "@kolu/surface/frame-limit";

import { WS_MAX_PAYLOAD_BYTES } from "./wsFrameCap";

/** A frame the framework carries and the old cap did not: bigger than the
 *  8 MiB `main.ts` used to pass to `ws`, smaller than the 16 MiB the framework
 *  refuses at. */
const DISPUTED_BYTES = 9 * 1024 * 1024;

/** What `main.ts` said before this fix. Named so the fence reads as the
 *  regression it is rather than as an arbitrary inequality. */
const OLD_CAP_BYTES = 8 * 1024 * 1024;

describe("the websocket frame cap", () => {
  it("does not refuse a frame the framework would carry", () => {
    // The framework's own predicate, not a re-statement of its number: this is
    // the half of the claim that says 9 MiB is the framework's business.
    expect(exceedsFrameLimit(DISPUTED_BYTES)).toBe(false);
    // ...and this is the half that was false. 9 MiB > the old 8 MiB cap.
    expect(DISPUTED_BYTES).toBeGreaterThan(OLD_CAP_BYTES);
    expect(DISPUTED_BYTES).toBeLessThanOrEqual(WS_MAX_PAYLOAD_BYTES);
  });

  it("is never the layer that says no first", () => {
    // Generalised, so a re-pin of either number cannot re-open the gap.
    expect(WS_MAX_PAYLOAD_BYTES).toBeGreaterThanOrEqual(RPC_MAX_FRAME_BYTES);
    // And the delimiter, as the property rather than as the expression: the
    // BIGGEST frame the decoder accepts is `RPC_MAX_FRAME_BYTES` of content
    // arriving in a message that also carries its newline, and that message
    // has to fit. A cap of exactly the framework's number passes the line
    // above and fails this one.
    expect(RPC_MAX_FRAME_BYTES + 1).toBeLessThanOrEqual(WS_MAX_PAYLOAD_BYTES);
  });

  it("is what main.ts hands the WebSocketServer", () => {
    // The constant is only worth pinning if it is the one on the wire, and
    // `main.ts` self-executes on import (it boots the server), so the call
    // site is read rather than exercised. Comments are stripped first, per
    // this repo's source-scan idiom: the prose explaining the cap naturally
    // quotes it, and a raw scan would pass on the explanation alone.
    // Line comments go FIRST: one of main.ts's own says `/assets/*`, and
    // stripping block comments ahead of it would read that as an opening
    // delimiter and swallow everything up to the next `*/` — the call site
    // included, which is how this assertion would pass on a file that no
    // longer contains it.
    const main = readFileSync(join(import.meta.dir, "main.ts"), "utf-8")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(main).toContain("maxPayload: WS_MAX_PAYLOAD_BYTES");
  });
});
