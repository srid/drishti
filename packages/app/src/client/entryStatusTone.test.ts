import type { EntryState } from "@kolu/surface-map";
import { testMembershipId } from "@kolu/surface-map/testing";
import { describe, expect, it } from "bun:test";
import {
  dotClass,
  statusLabel,
  statusPending,
  statusTextClass,
  statusTitle,
} from "./entryStatusTone";

// PR3: every published EntryStatus arm carries an opaque `membershipId` (a branded
// `MembershipId` — a bare `""` is a type error). These tone/label helpers read
// `.kind`/`.failure`/`.clockOffset` only, so a fixture mints one through the
// sanctioned `testMembershipId()` helper, never a literal.
const CONNECTED: EntryState = {
  kind: "connected",
  membershipId: testMembershipId(),
  clockOffset: 0,
};
const WARMING: EntryState = {
  kind: "warming",
  membershipId: testMembershipId(),
};
// PR4: the failed arm carries a schema-valid domain `failure` value (drishti's is
// `{ reason }`), not a bare `reason`/`cause` pair — read as `.failure.reason`.
const FAILED: EntryState<{ reason: string }> = {
  kind: "failed",
  membershipId: testMembershipId(),
  failure: { reason: "connection refused" },
};
const NOT_A_MEMBER: EntryState = { kind: "not-a-member" };

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

  it("only warming pulses — connected and failed are steady", () => {
    expect(statusPending(WARMING)).toBe(true);
    expect(statusPending(CONNECTED)).toBe(false);
    expect(statusPending(FAILED)).toBe(false);
    expect(statusPending(NOT_A_MEMBER)).toBe(false);
  });

  it("surfaces the failure reason in the title, never invented text", () => {
    expect(statusTitle(FAILED)).toBe("failed: connection refused");
  });

  it("covers every EntryState kind with a label", () => {
    for (const s of [CONNECTED, WARMING, FAILED, NOT_A_MEMBER]) {
      expect(statusLabel(s).length).toBeGreaterThan(0);
    }
  });
});
