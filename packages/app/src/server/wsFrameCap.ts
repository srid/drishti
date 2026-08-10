/**
 * The largest websocket message the parent server will take — the framework's
 * own frame cap, and not a number of ours.
 *
 * `@kolu/surface` owns the wire's frame size (`RPC_MAX_FRAME_BYTES`, 16 MiB)
 * AND owns what happens to a frame that busts it: the ndjson decoder
 * classifies the overflow and closes with the documented 1009 its
 * `frame-limit` module names, which the client recognises as a RECOVERABLE
 * transport death — reconnect, re-subscribe, and the per-subscription retry
 * fence restores what was lost.
 *
 * A lower cap here does not make the wire safer. It moves the refusal one
 * layer DOWN, to a place with no classifier, no documented close and no client
 * that knows what happened — just a socket that died. And in drishti that is
 * expensive out of proportion to the one bad frame: since the `@kolu/surface-map`
 * adoption a browser tab multiplexes the admin control plane AND every
 * configured host's telemetry onto ONE socket, so a raw-layer death takes the
 * whole fleet view down, not one host's stream.
 *
 * `main.ts` used to say `8 * 1024 * 1024`, half the framework's number, so
 * every frame in between died at the wrong layer. Sourcing the constant means
 * the two layers can no longer disagree, whatever either of them is re-pinned
 * to; `wsFrameCap.test.ts` fails if they do.
 *
 * It is a DECLARATION more than a setting under the runtime we ship. Bun's
 * built-in `ws` is what `import { WebSocketServer } from "ws"` resolves to,
 * and it ignores `maxPayload` in favour of a 16 MiB ceiling of its own
 * (measured 2026-08-10 in this worktree: a server capped at 1024 was handed
 * 4096 bytes and delivered them; 16777216 delivered, one byte more closed 1006
 * "Received too big message"). Two consequences worth stating rather than
 * discovering: no `maxPayload` we pass moves that ceiling, and while it stands
 * the framework's handled INBOUND oversize path is unreachable here at all — a
 * frame the decoder would refuse is already past bun's limit, and even one at
 * exactly the cap arrives a delimiter byte over it and dies at 1006 rather
 * than 1009. A node host obeys the option, and a bun that implements it would
 * too, which is why the number still has to be right — and why the test pins
 * the number rather than the behaviour.
 */

import { RPC_MAX_FRAME_BYTES } from "@kolu/surface/frame-limit";

/** The newline an ndjson frame ends with. The encoder writes
 *  `JSON.stringify(…) + "\n"` as one message, so it is on the wire — but the
 *  decoder measures the line WITHOUT it (`nlIndex - position`). One byte, and
 *  it is the difference between the two caps meeting and missing. */
const NDJSON_DELIMITER_BYTES = 1;

export const WS_MAX_PAYLOAD_BYTES =
  RPC_MAX_FRAME_BYTES + NDJSON_DELIMITER_BYTES;
