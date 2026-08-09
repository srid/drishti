import type { EntryState } from "@kolu/surface-map";
import { testMembershipId } from "@kolu/surface-map/testing";
import { DEFAULT_CONNECTION } from "drishti-common/browser";
import { describe, expect, it } from "bun:test";
import {
  connectionOf,
  connectionPhaseOf,
  dotClass,
  failureRecord,
  statusLabel,
  statusPending,
  statusTextClass,
  statusTitle,
} from "./entryStatusTone";

// PR3: every published EntryStatus arm carries an opaque `membershipId` (a branded
// `MembershipId` — a bare `""` is a type error). These tone/label helpers read
// `.kind`/`.failure`/`.clockOffset` only, so a fixture mints one through the
// sanctioned `testMembershipId()` helper, never a literal.
const CONNECTED: EntryState<{ reason: string }> = {
  kind: "connected",
  membershipId: testMembershipId(),
  clockOffset: 0,
};
const WARMING: EntryState<{ reason: string }> = {
  kind: "warming",
  membershipId: testMembershipId(),
};
// PR4: the failed arm carries a schema-valid domain `failure` value (drishti's is
// `{ reason }`), not a bare `reason`/`cause` pair — read as `.failure.reason`.
// kolu#2022: it ALSO carries that reason's `evidence` — required, so a fixture can no
// longer spell a reason whose retained output tail is missing.
const FAILED: EntryState<{ reason: string }> = {
  kind: "failed",
  membershipId: testMembershipId(),
  failure: { reason: "connection refused" },
  evidence: [
    { source: "local", line: "ssh: connect to host box port 22" },
    { source: "remote", line: "Connection refused" },
  ],
};
// kolu#2129: the CLIENT-only arm the liveness floor mints when OUR link to the
// publisher is dead. It replaces the floor's old lossy demotion to `warming`, which
// made "the publisher says it is coming up" and "we cannot see the publisher" the same
// value; `published` records the last word we actually heard.
const UNOBSERVABLE: EntryState<{ reason: string }> = {
  kind: "unobservable",
  membershipId: testMembershipId(),
  published: "connected",
};
const NOT_A_MEMBER: EntryState<{ reason: string }> = { kind: "not-a-member" };

describe("entryStatusTone", () => {
  it("greens only the connected dot", () => {
    expect(dotClass(CONNECTED)).toContain("emerald");
    expect(dotClass(WARMING)).not.toContain("emerald");
    expect(dotClass(FAILED)).not.toContain("emerald");
    expect(dotClass(NOT_A_MEMBER)).not.toContain("emerald");
  });

  it("reds only the failed dot", () => {
    expect(dotClass(FAILED)).toContain("red");
    expect(dotClass(CONNECTED)).not.toContain("red");
  });

  it("statusTextClass tracks the same tone as the dot", () => {
    expect(statusTextClass(CONNECTED)).toBe("text-emerald-500");
    expect(statusTextClass(FAILED)).toBe("text-red-500");
    expect(statusTextClass(WARMING)).toBe("text-amber-500");
  });

  it("the two UNSETTLED arms pulse — connected and failed are steady", () => {
    expect(statusPending(WARMING)).toBe(true);
    // Blind is unsettled too. A `kind === "warming"` test — which this used to be —
    // would have frozen the pulse the moment the admin link dropped.
    expect(statusPending(UNOBSERVABLE)).toBe(true);
    expect(statusPending(CONNECTED)).toBe(false);
    expect(statusPending(FAILED)).toBe(false);
    expect(statusPending(NOT_A_MEMBER)).toBe(false);
  });

  // kolu#2129 — the arm exists so a consumer can tell "it is coming up" from "we cannot
  // see it". Every projection here has to keep them apart; the ones that must NOT is a
  // shorter list (the pulse above, which is genuinely the same question).
  it("says 'we cannot see it' rather than borrowing the word for 'coming up'", () => {
    expect(dotClass(UNOBSERVABLE)).not.toBe(dotClass(WARMING));
    expect(dotClass(UNOBSERVABLE)).not.toContain("emerald");
    expect(dotClass(UNOBSERVABLE)).not.toContain("red");
    expect(statusTextClass(UNOBSERVABLE)).not.toBe(statusTextClass(WARMING));
    expect(statusLabel(UNOBSERVABLE)).not.toBe(statusLabel(WARMING));
    // The tooltip names the last thing we heard — the most useful fact a stale tab has.
    expect(statusTitle(UNOBSERVABLE)).toContain("connected");
    // Not a failure: nothing here is a post-mortem.
    expect(failureRecord(UNOBSERVABLE)).toBeNull();
  });

  // The DEFAULT_CONNECTION trap, reopened on the third side. A blind entry carries no
  // `connection` payload, so `connectionOf(...) ?? DEFAULT_CONNECTION.phase` would have
  // painted an amber "connecting…" word over a host we simply cannot hear.
  it("paints a blind entry's word off its own arm, never the gate-closed default", () => {
    expect(connectionOf(UNOBSERVABLE)).toBeUndefined();
    expect(connectionPhaseOf(UNOBSERVABLE)).toBe("disconnected");
    expect(connectionPhaseOf(UNOBSERVABLE)).not.toBe(
      DEFAULT_CONNECTION.phase,
    );
  });

  it("surfaces the failure reason in the title, never invented text", () => {
    expect(statusTitle(FAILED)).toBe("failed: connection refused");
  });

  // kolu#2022 — the failure page reads its reason AND its evidence through the SAME
  // seam the dot reads, so the two can't disagree about whether a host is failed, and
  // the tail it renders is the pinned post-mortem record (which survives the liveness
  // floor) rather than the live `connection.log` (which does not).
  it("hands the failure page the reason WITH its evidence, and nothing for an up host", () => {
    expect(failureRecord(FAILED)).toEqual({
      reason: "connection refused",
      evidence: [
        { source: "local", line: "ssh: connect to host box port 22" },
        { source: "remote", line: "Connection refused" },
      ],
    });
    expect(failureRecord(CONNECTED)).toBeNull();
    expect(failureRecord(WARMING)).toBeNull();
    expect(failureRecord(NOT_A_MEMBER)).toBeNull();
  });

  it("covers every EntryState kind with a label", () => {
    for (const s of [CONNECTED, WARMING, FAILED, UNOBSERVABLE, NOT_A_MEMBER]) {
      expect(statusLabel(s).length).toBeGreaterThan(0);
    }
  });
});
