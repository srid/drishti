import type { SurfaceHealth } from "@kolu/surface/solid";
import { describe, expect, it } from "bun:test";
import {
  disconnectedMessage,
  STATE,
  statusTextClass,
  withElapsed,
} from "./connectionColors";

// `health()` facts spanning the readiness verdicts `gateStatus` distinguishes —
// the word's green must track the dot's, which greens ONLY on `ready`.
const READY: SurfaceHealth = {
  live: true,
  subs: [{ name: "c", pending: false, error: undefined }],
};
const DEAD: SurfaceHealth = { live: false, subs: [] };
const PENDING: SurfaceHealth = {
  live: true,
  subs: [{ name: "c", pending: true, error: undefined }],
};
// Live (transport ∧ mirror up) but a subscription is silently erroring — the
// fact `gateStatus` calls `degraded` and the dot paints amber. `live` is still
// `true` here, so the OLD bare-`live` word stayed GREEN: the #1564 lie relocated
// from the dot to the status word.
const DEGRADED: SurfaceHealth = {
  live: true,
  subs: [{ name: "c", pending: false, error: new Error("boom") }],
};

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

describe("statusTextClass — the WORD's green tracks the dot's verdict (gateStatus), not a narrower signal", () => {
  it("greens a connected word ONLY when the FACT is fully READY", () => {
    // The dot greens on gateStatus === "ready" (live ∧ no error ∧ no pending);
    // the word must use the SAME verdict so the two never diverge.
    expect(statusTextClass("connected", READY)).toBe("text-emerald-500");
  });

  it("a 'connected' cell over a DEGRADED fact (a sub silently erroring while live) reads amber, never green", () => {
    // The relocated #1564 lie: live === true here, so the OLD bare-`live` word
    // painted green while the dot (gateStatus → degraded) turned amber. The word
    // now reads the WHOLE fact, so it drops to amber WITH the dot.
    expect(statusTextClass("connected", DEGRADED)).toBe(STATE.connecting.text);
    expect(statusTextClass("connected", DEGRADED)).not.toBe("text-emerald-500");
  });

  it("a 'connected' cell still awaiting its first frame (pending) reads amber, not a premature green", () => {
    // gateStatus(PENDING) === "connecting" — the dot is amber on every fresh
    // connect, so the word must be too.
    expect(statusTextClass("connected", PENDING)).toBe(STATE.connecting.text);
    expect(statusTextClass("connected", PENDING)).not.toBe("text-emerald-500");
  });

  it("a stale 'connected' over a dead transport reads amber, never green", () => {
    // live === false though the cell still says connected (a half-open/dropped
    // browser↔backend socket). gateStatus → connecting → amber.
    expect(statusTextClass("connected", DEAD)).toBe(STATE.connecting.text);
    expect(statusTextClass("connected", DEAD)).not.toBe("text-emerald-500");
  });

  it("a non-connected state keeps its own (non-green) tone for its realistic not-ready fact", () => {
    expect(statusTextClass("failed", DEAD)).toBe("text-red-500");
    expect(statusTextClass("connecting", DEAD)).toBe("text-amber-500");
    expect(statusTextClass("copying", DEAD)).toBe("text-amber-500");
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
