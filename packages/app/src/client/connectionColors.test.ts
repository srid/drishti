import { describe, expect, it } from "bun:test";
import type { ConnectionState } from "../common/surface";
import { STATE } from "./connectionColors";

const ALL_STATES: ConnectionState[] = [
  "copying",
  "connecting",
  "connected",
  "disconnected",
  "failed",
];

describe("connection STATE presentation", () => {
  it("covers every connection state", () => {
    for (const s of ALL_STATES) {
      expect(STATE[s]).toBeDefined();
    }
  });

  it("treats disconnected as transient work-in-progress, not terminal", () => {
    // The honesty fix: `disconnected` is the gap between retry attempts,
    // so it pulses amber and reads "Reconnecting…" — not the old red,
    // non-pulsing "Disconnected. Retrying…" that also covered give-up.
    expect(STATE.disconnected.pending).toBe(true);
    expect(STATE.disconnected.dotBg).toBe("bg-amber-500");
    expect(STATE.disconnected.message).toBe("Reconnecting…");
  });

  it("treats failed as terminal — red, not pulsing", () => {
    expect(STATE.failed.pending).toBe(false);
    expect(STATE.failed.dotBg).toBe("bg-red-500");
  });

  it("only connected is non-pending and emerald", () => {
    expect(STATE.connected.pending).toBe(false);
    expect(STATE.connected.dotBg).toBe("bg-emerald-500");
    // copying/connecting are in-flight → pending.
    expect(STATE.copying.pending).toBe(true);
    expect(STATE.connecting.pending).toBe(true);
  });
});
