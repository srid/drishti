/**
 * U2.7: RENDER DaemonStatusChip + DaemonDialog for every closed status arm;
 * renew result becomes state; confinement binds production props.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonStatus } from "../common/daemonStatus";
import {
  type DaemonChipKind,
  chipFromDaemonStatus,
  identityRows,
  type RenewUiState,
  applyRenewResult,
  applyRenewStart,
} from "./daemonStatusPresentation";

const appSrc = readFileSync(join(import.meta.dir, "App.tsx"), "utf8");
const tabSrc = readFileSync(join(import.meta.dir, "TabStrip.tsx"), "utf8");
const chipSrc = readFileSync(join(import.meta.dir, "DaemonStatusChip.tsx"), "utf8");
const dialogSrc = readFileSync(join(import.meta.dir, "DaemonDialog.tsx"), "utf8");

function status(over: Partial<DaemonStatus>): DaemonStatus {
  return {
    anomaly: null,
    outcome: null,
    identity: null,
    phase: "connected",
    ...over,
  };
}

/** Every closed chip kind must produce a distinct presentation (render-level contract). */
const ARMS: { name: string; status: DaemonStatus; kind: DaemonChipKind }[] = [
  {
    name: "clean",
    status: status({ phase: "connected" }),
    kind: "clean",
  },
  {
    name: "adopted-stale",
    status: status({
      anomaly: {
        kind: "adopted-stale",
        detail: "d",
        running: {
          contractVersion: "1.0",
          build: { kind: "known", id: "a" },
        },
        expected: {
          contractVersion: "1.0",
          build: { kind: "known", id: "b" },
        },
      },
    }),
    kind: "adopted-stale",
  },
  {
    name: "skew-refused",
    status: status({
      anomaly: {
        kind: "skew-refused",
        detail: "d",
        running: {
          contractVersion: "9.9",
          build: { kind: "known", id: "a" },
        },
        expected: {
          contractVersion: "1.0",
          build: { kind: "known", id: "b" },
        },
      },
    }),
    kind: "skew-refused",
  },
  {
    name: "cross-supervisor",
    status: status({
      anomaly: {
        kind: "cross-supervisor",
        detail: "d",
        drained: { kind: "instance", key: 1 },
        observed: { kind: "pre-instance" },
        running: {
          contractVersion: "1.0",
          build: { kind: "off-nix" },
        },
      },
    }),
    kind: "cross-supervisor",
  },
  {
    name: "drained-with-persist-failure",
    status: status({
      anomaly: {
        kind: "drained-with-persist-failure",
        detail: "d",
        error: "EACCES",
      },
    }),
    kind: "drained-with-persist-failure",
  },
  {
    name: "unconverged",
    status: status({
      anomaly: {
        kind: "unconverged",
        detail: "d",
        running: null,
        expected: {
          contractVersion: "1.0",
          build: { kind: "known", id: "e" },
        },
        cause: {
          kind: "budget-exhausted",
          axis: "build",
          attempts: 2,
          maxAttempts: 2,
        },
      },
    }),
    kind: "unconverged",
  },
  {
    name: "link-failed",
    status: status({
      anomaly: { kind: "link-failed", detail: "ssh died" },
    }),
    kind: "link-failed",
  },
  {
    name: "boot-refused",
    status: status({
      phase: "failed",
      anomaly: {
        kind: "boot-refused",
        detail: "daemonHome: refuse",
        message: "daemonHome: refuse",
      },
    }),
    kind: "boot-refused",
  },
  {
    name: "off-nix",
    status: status({
      phase: "disconnected",
      outcome: {
        kind: "resolve-failed",
        resolutionKind: "unavailable",
      },
    }),
    kind: "off-nix",
  },
  {
    name: "disconnected",
    status: status({ phase: "disconnected" }),
    kind: "disconnected",
  },
  {
    name: "warming",
    status: status({ phase: "probing" }),
    kind: "warming",
  },
];

describe("U2.7 chip presentation for every closed arm", () => {
  for (const arm of ARMS) {
    it(`chip kind ${arm.name}`, () => {
      const p = chipFromDaemonStatus(arm.status);
      expect(p.kind).toBe(arm.kind);
      // Component uses presentation.label and tone — pin they are non-empty.
      expect(p.label.length).toBeGreaterThan(0);
      expect(["ok", "warn", "down", "warming", "muted"]).toContain(p.tone);
    });
  }

  it("null status is unknown (mutation: status={null} still paints a word)", () => {
    expect(chipFromDaemonStatus(null).kind).toBe("unknown");
  });
});

describe("U2.7 dialog fields for a connected host", () => {
  it("identity rows present", () => {
    const rows = identityRows({
      stateRoot: "/s",
      contractVersion: "1.0",
      startedAt: 1,
      commit: "c",
      buildId: "b",
    });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.value.length > 0)).toBe(true);
  });

  it("renew result becomes state", () => {
    let renew: RenewUiState = { kind: "idle" };
    renew = applyRenewStart(renew);
    expect(renew.kind).toBe("pending");
    renew = applyRenewResult({ ok: true });
    expect(renew.kind).toBe("ok");
  });
});

describe("U2.7 production call-site confinement (props bound)", () => {
  it("TabChip and HostCard render DaemonStatusChip from shared store", () => {
    expect(tabSrc).toMatch(/DaemonStatusChip/);
    expect(tabSrc).toMatch(/daemonStore\.byHost\(\)\[props\.host\]/);
    expect(tabSrc).toMatch(/setDialogHost\(props\.host\)/);
    expect(appSrc).toMatch(/HostCard[\s\S]*DaemonStatusChip|DaemonStatusChip[\s\S]*HostCard/);
    // HostCard uses the store (not a null literal).
    expect(appSrc).toMatch(
      /function HostCard[\s\S]*DaemonStatusChip[\s\S]*status=\{daemonStatus\(\)\}/,
    );
  });

  it("Header chip gets daemonStatus() from store, not status={null}", () => {
    expect(appSrc).toMatch(
      /DaemonStatusChip[\s\S]{0,80}status=\{props\.daemonStatus\}|status=\{daemonStatus\(\)\}/,
    );
    // Mutation: status={null} at production chip sites must red.
    expect(appSrc).not.toMatch(
      /DaemonStatusChip[\s\S]{0,40}status=\{\s*null\s*\}/,
    );
    expect(tabSrc).not.toMatch(
      /DaemonStatusChip[\s\S]{0,40}status=\{\s*null\s*\}/,
    );
  });

  it("DaemonDialog is wired to store dialogHost + renew/reconnect", () => {
    expect(appSrc).toMatch(/DaemonDialog/);
    expect(appSrc).toMatch(/daemonStore\.renew\(/);
    expect(appSrc).toMatch(/daemonStore\.reconnect\(/);
    expect(appSrc).toMatch(/dialogHost/);
    // Dialog component requires status/onRenew props by name.
    expect(dialogSrc).toMatch(/onRenew/);
    expect(dialogSrc).toMatch(/props\.status/);
    expect(chipSrc).toMatch(/props\.status/);
  });

  it("single fleet poll — HostView does not call hosts.daemonStatus", () => {
    // HostView must not open a second polling authority.
    const hostViewSlice = appSrc.slice(
      appSrc.indexOf("function HostView"),
      appSrc.indexOf("function Header"),
    );
    expect(hostViewSlice).not.toMatch(/hosts\.daemonStatus\s*\(/);
    expect(appSrc).toMatch(/startDaemonStatusPoll/);
    expect(appSrc).toMatch(/createDaemonStatusStore/);
  });
});
