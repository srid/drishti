/**
 * SR9 · srid/drishti#102 regression pin — ONE connection authority.
 *
 * The bug: the connection DOT read the host-map entry's `EntryStatus`
 * (transport-floored — it went green the moment the link was live) while the
 * status WORD read a SEPARATE `cells.connection` subscription that could lag or
 * wedge at "connecting…" forever. Result: a green dot beside a permanent
 * "connecting" word, streaming metrics and all (#102).
 *
 * SR9 folds the fine connection ONTO the entry
 * (`EntryState<Failure, ConnectionInfo>.connection`), co-produced with the coarse
 * arm from one `SessionState` frame in kolu's single `serveHostMap` resolve — and
 * kolu's `serveHostMap` asserts `EntryStatus === connected` iff
 * `connection.phase === connected` before publication, so a half-updated pair has
 * no construction path server-side. This test is the CLIENT-side fence: drishti
 * derives BOTH the dot (`dotClass`) and the word (`connectionOf` → the fine
 * `ConnectionInfo`) from the SAME `entry.state()` frame, so they cannot disagree —
 * there is exactly one source. drishti has no browser e2e harness to drive a real
 * connected host, so this steady-state joint-render assertion at the client's sole
 * `entry.state()` seam is the achievable realization of the "dot AND word agree in
 * one settled frame" invariant.
 */
import type { EntryState } from "@kolu/surface-map";
import { testMembershipId } from "@kolu/surface-map/testing";
import { describe, expect, it } from "bun:test";
import type { ConnectionInfo } from "drishti-common/browser";
import { STATE } from "./connectionColors";
import { connectionOf, dotClass, statusTextClass } from "./entryStatusTone";

/** One settled connected frame — the SINGLE object the dot AND the word read. */
const connectedFrame: EntryState<{ reason: string }, ConnectionInfo> = {
  kind: "connected",
  membershipId: testMembershipId(),
  clockOffset: 0,
  connection: {
    phase: "connected",
    clockOffset: 0,
    log: [],
    sinceMs: 0,
    campaignEpoch: 0,
  },
};

describe("connection authority (drishti#102 regression)", () => {
  it("derives the dot and the word from ONE frame — both read connected", () => {
    // The word is projected from the SAME frame the dot reads — the sole
    // `entry.state()` seam, never a second `cells.connection` subscription.
    const conn = connectionOf(connectedFrame);
    expect(conn).toBeDefined();

    // Coarse dot (status.kind) and fine word (connection.phase) both say
    // "connected", and their colours agree — green beside "connected".
    expect(dotClass(connectedFrame)).toContain("emerald"); // the dot
    expect(statusTextClass(connectedFrame)).toContain("emerald");
    expect(STATE[conn!.phase].label).toBe("connected"); // the word
    expect(STATE[conn!.phase].text).toContain("emerald"); // word colour agrees
    expect(STATE[conn!.phase].pending).toBe(false); // not "still connecting"
  });

  it("has no path to a connected dot beside a still-connecting word", () => {
    // The #102 shape — a connected dot whose word is stuck "connecting" — is
    // unrepresentable: the word's phase IS this frame's `connection.phase`, so a
    // connected frame yields a non-pending, connected word by construction. There
    // is no independent signal left that could sit at "connecting" on its own.
    const conn = connectionOf(connectedFrame);
    expect(conn?.phase).toBe("connected");
    expect(STATE[conn!.phase].label).not.toBe("connecting…");
  });

  it("a warming frame's word tracks its own fine phase (still one source)", () => {
    // A host still coming up: the dot is amber (warming) and the word rides the
    // fine phase from the SAME frame — "provisioning" reads "provisioning agent…".
    const warmingFrame: EntryState<{ reason: string }, ConnectionInfo> = {
      kind: "warming",
      membershipId: testMembershipId(),
      connection: {
        phase: "provisioning",
        log: [],
        sinceMs: 0,
        campaignEpoch: 0,
      },
    };
    expect(dotClass(warmingFrame)).not.toContain("emerald"); // dot: not green
    const conn = connectionOf(warmingFrame);
    expect(STATE[conn!.phase].pending).toBe(true); // word: in-flight, agrees
  });
});
