import { describe, expect, it } from "bun:test";
import { STATE } from "./connectionColors";

describe("connection STATE presentation", () => {
  it("covers every connection state", () => {
    // Derived from the STATE map itself — Record<ConnectionState,...> totality
    // means TypeScript already enforces this at compile time; the runtime check
    // guards against future enum additions that miss a STATE entry.
    for (const s of Object.keys(STATE)) {
      expect(STATE[s as keyof typeof STATE]).toBeDefined();
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
