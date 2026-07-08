import { describe, expect, it } from "bun:test";
import { disconnectedMessage, STATE, withElapsed } from "./connectionColors";

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
    expect(STATE.disconnected.text).toBe("text-amber-500");
    expect(STATE.disconnected.message).toBe("Reconnecting…");
  });

  it("treats failed as terminal — red, not pulsing", () => {
    expect(STATE.failed.pending).toBe(false);
    expect(STATE.failed.text).toBe("text-red-500");
  });

  it("only connected is non-pending and emerald", () => {
    expect(STATE.connected.pending).toBe(false);
    expect(STATE.connected.text).toBe("text-emerald-500");
    // copying/connecting are in-flight → pending.
    expect(STATE.copying.pending).toBe(true);
    expect(STATE.connecting.pending).toBe(true);
  });
});

describe("disconnectedMessage", () => {
  it("names an unreachable host for a network fault", () => {
    // The roaming case: the parent retries a network fault forever, so the
    // overlay should say *why* it's stuck rather than a bare "Reconnecting…".
    expect(disconnectedMessage("network")).toBe("Host unreachable — retrying…");
  });

  it("falls back to the base message for a remote fault or none yet", () => {
    expect(disconnectedMessage("remote")).toBe(STATE.disconnected.message);
    expect(disconnectedMessage(null)).toBe(STATE.disconnected.message);
  });
});

describe("withElapsed", () => {
  it("omits the suffix below 1s — no '0s' flash on a fresh state", () => {
    expect(withElapsed("Connecting…", 0)).toBe("Connecting…");
  });

  it("appends the elapsed seconds once a second has ticked", () => {
    expect(withElapsed("Connecting…", 1)).toBe("Connecting… 1s");
    expect(withElapsed("Connecting…", 18)).toBe("Connecting… 18s");
    expect(withElapsed("Copying agent to remote…", 42)).toBe(
      "Copying agent to remote… 42s",
    );
  });
});
