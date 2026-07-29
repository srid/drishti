/**
 * U3.2 / U3.3 / U3.4: RENDER DaemonStatusChip + DaemonDialog for every closed
 * status arm; renew result becomes reactive state; boot-refused hides Renew;
 * sibling chip/selection controls (no nested buttons); store binding proof.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import { createSignal, type Accessor, type Setter } from "solid-js";
import type { DaemonStatus } from "../common/daemonStatus";
import {
  DaemonStatusChip,
  FleetDaemonStatusChip,
} from "./DaemonStatusChip";
import { DaemonDialog } from "./DaemonDialog";
import { HostCardGlance, TabHostGlance } from "./daemonHostGlance";
import {
  type DaemonChipKind,
  chipFromDaemonStatus,
  chipGlanceVisible,
  type RenewUiState,
  applyRenewResult,
  applyRenewStart,
} from "./daemonStatusPresentation";
import {
  DaemonStatusCtx,
  type DaemonStatusStore,
  type DaemonStatusMap,
  type RenewStateMap,
} from "./daemonStatusStore";

const glanceSrc = readFileSync(
  join(import.meta.dir, "daemonHostGlance.tsx"),
  "utf8",
);
const tabSrc = readFileSync(join(import.meta.dir, "TabStrip.tsx"), "utf8");
const appSrc = readFileSync(join(import.meta.dir, "App.tsx"), "utf8");
const chipSrc = readFileSync(
  join(import.meta.dir, "DaemonStatusChip.tsx"),
  "utf8",
);

/** Minimal EntryState lens for glance placements (no live hostMap). */
function fakeEntryState(
  kind: "connected" | "disconnected" | "failed" = "connected",
  // Production glance only needs kind + failure.reason for HostDot; cast the
  // test double rather than minting branded membership IDs.
): () => import("@kolu/surface-map").EntryState<
  { reason: string },
  import("drishti-common/browser").ConnectionInfo
> {
  return () => {
    if (kind === "connected") {
      return {
        kind: "connected",
        membershipId: "test" as never,
        clockOffset: null,
      } as never;
    }
    if (kind === "failed") {
      return {
        kind: "failed",
        failure: { reason: "test-fail" },
      } as never;
    }
    return { kind: "disconnected" } as never;
  };
}

afterEach(() => cleanup());

function status(over: Partial<DaemonStatus>): DaemonStatus {
  return {
    anomaly: null,
    outcome: null,
    identity: null,
    phase: "connected",
    ...over,
  };
}

/** Every closed chip kind must paint a distinct label in the real DOM. */
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

function mockStore(opts: {
  byHost?: DaemonStatusMap;
  renewByHost?: RenewStateMap;
  dialogHost?: string | null;
  onRenew?: (host: string) => void;
  onReconnect?: (host: string) => void;
  onSetDialogHost?: (host: string | null) => void;
}): DaemonStatusStore {
  const byHost: Accessor<DaemonStatusMap> = () => opts.byHost ?? {};
  const renewByHost: Accessor<RenewStateMap> = () => opts.renewByHost ?? {};
  const [dialogHost, setDialogHost] = createSignal<string | null>(
    opts.dialogHost ?? null,
  );
  const setDialog: Setter<string | null> = ((v) => {
    const next =
      typeof v === "function"
        ? (v as (p: string | null) => string | null)(dialogHost())
        : v;
    setDialogHost(next);
    opts.onSetDialogHost?.(next);
    return next;
  }) as Setter<string | null>;

  return {
    byHost,
    pollErrorByHost: () => ({}),
    renewByHost,
    dialogHost,
    setDialogHost: setDialog,
    pollHost: () => {},
    pollAll: () => {},
    renew: (host) => opts.onRenew?.(host),
    reconnect: (host) => opts.onReconnect?.(host),
  };
}

describe("U3.2 chip presentation rendered for every closed arm", () => {
  for (const arm of ARMS) {
    it(`renders chip kind ${arm.name}`, () => {
      const p = chipFromDaemonStatus(arm.status);
      expect(p.kind).toBe(arm.kind);
      render(() => <DaemonStatusChip status={arm.status} />);
      const label = screen.getByTestId("daemon-status-chip-label");
      expect(label.textContent).toBe(p.label);
      expect(label.textContent!.length).toBeGreaterThan(0);
    });
  }

  it("null status paints unknown word (daemon…)", () => {
    render(() => <DaemonStatusChip status={null} />);
    expect(screen.getByTestId("daemon-status-chip-label").textContent).toBe(
      "daemon…",
    );
  });
});

describe("U3.2 / U3.3 rendered DaemonDialog", () => {
  const connected: DaemonStatus = status({
    phase: "connected",
    identity: {
      stateRoot: "/s",
      contractVersion: "1.0",
      startedAt: 1,
      // Non-empty commit + buildId (joint invariant of the outer agent stamp).
      commit: "abc1234deadbeef",
      buildId: "bld-known-id",
    },
  });

  const bootRefused: DaemonStatus = status({
    phase: "failed",
    anomaly: {
      kind: "boot-refused",
      detail: "daemonHome: refuse",
      message: "daemonHome: refuse",
    },
    outcome: { kind: "boot-refused", message: "daemonHome: refuse" },
  });

  const adoptedStale: DaemonStatus = status({
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
  });

  it("connected identity rows + Renew action present", async () => {
    let renewed = false;
    let reconnected = false;
    render(() => (
      <DaemonDialog
        open={true}
        onOpenChange={() => {}}
        host="h1.example"
        status={connected}
        renewState={{ kind: "idle" }}
        onRenew={() => {
          renewed = true;
        }}
        onReconnect={() => {
          reconnected = true;
        }}
      />
    ));
    expect(screen.getByText("h1.example")).toBeTruthy();
    expect(screen.getByText("/s")).toBeTruthy();
    // Outer agent wrapper stamps COMMIT_HASH — dialog must paint the commit
    // when identity carries a non-empty value (not the honest-unknown dash).
    expect(screen.getByText("abc1234deadbeef")).toBeTruthy();
    expect(screen.getByText("bld-known-id")).toBeTruthy();
    const renew = screen.getByTestId("daemon-dialog-renew");
    const reconnect = screen.getByTestId("daemon-dialog-reconnect");
    await fireEvent.click(renew);
    expect(renewed).toBe(true);
    await fireEvent.click(reconnect);
    expect(reconnected).toBe(true);
  });

  it("reactive renew result becomes visible state", async () => {
    const [renew, setRenew] = createSignal<RenewUiState>({ kind: "idle" });
    render(() => (
      <DaemonDialog
        open={true}
        onOpenChange={() => {}}
        host="h1"
        status={connected}
        renewState={renew()}
        onRenew={() => {
          setRenew(applyRenewStart(renew()));
          setRenew(applyRenewResult({ ok: true }));
        }}
        onReconnect={() => {}}
      />
    ));
    expect(screen.queryByText("Renew ok — reconnecting")).toBeNull();
    await fireEvent.click(screen.getByTestId("daemon-dialog-renew"));
    expect(renew().kind).toBe("ok");
    expect(screen.getByText("Renew ok — reconnecting")).toBeTruthy();
  });

  it("U3.3 boot-refused: Reconnect only — no Renew", () => {
    render(() => (
      <DaemonDialog
        open={true}
        onOpenChange={() => {}}
        host="bad-host"
        status={bootRefused}
        renewState={{ kind: "idle" }}
        onRenew={() => {
          throw new Error("Renew must not be offered for boot-refused");
        }}
        onReconnect={() => {}}
      />
    ));
    expect(screen.getByTestId("daemon-dialog-reconnect")).toBeTruthy();
    expect(screen.queryByTestId("daemon-dialog-renew")).toBeNull();
    expect(screen.getByText("Agent boot refused")).toBeTruthy();
    expect(screen.getByText("daemonHome: refuse")).toBeTruthy();
  });

  it("adopted-stale still offers Renew (resident drain is meaningful)", () => {
    render(() => (
      <DaemonDialog
        open={true}
        onOpenChange={() => {}}
        host="stale"
        status={adoptedStale}
        renewState={{ kind: "idle" }}
        onRenew={() => {}}
        onReconnect={() => {}}
      />
    ));
    expect(screen.getByTestId("daemon-dialog-renew")).toBeTruthy();
    expect(screen.getByText("Action needed")).toBeTruthy();
  });
});

describe("U3.2 store binding — FleetDaemonStatusChip", () => {
  const bootRefused = status({
    phase: "failed",
    anomaly: {
      kind: "boot-refused",
      detail: "daemonHome: refuse",
      message: "daemonHome: refuse",
    },
  });

  const cleanHealthy = status({ phase: "connected" });

  it("selected host store status reaches rendered chip props", async () => {
    let opened: string | undefined;
    const store = mockStore({
      byHost: { "host-a": bootRefused },
      onSetDialogHost: (h) => {
        opened = h ?? undefined;
      },
    });
    render(() => (
      <DaemonStatusCtx.Provider value={store}>
        <FleetDaemonStatusChip host="host-a" />
      </DaemonStatusCtx.Provider>
    ));
    // Bound status paints boot-refused label — not the null/unknown word.
    expect(screen.getByTestId("daemon-status-chip-label").textContent).toBe(
      "boot refused",
    );
    expect(screen.getByTestId("daemon-status-chip-label").textContent).not.toBe(
      "daemon…",
    );
    await fireEvent.click(screen.getByTestId("daemon-status-chip"));
    expect(opened).toBe("host-a");
  });

  it("healthy: glyph present + dialog reachable + no loud chip", async () => {
    // Loud chip is quiet when healthy; glyph is the durable dialog entry.
    expect(chipGlanceVisible(chipFromDaemonStatus(cleanHealthy))).toBe(false);
    let opened: string | undefined;
    const store = mockStore({
      byHost: { "host-ok": cleanHealthy },
      onSetDialogHost: (h) => {
        opened = h ?? undefined;
      },
    });
    render(() => (
      <DaemonStatusCtx.Provider value={store}>
        <FleetDaemonStatusChip host="host-ok" />
      </DaemonStatusCtx.Provider>
    ));
    expect(screen.getByTestId("daemon-dialog-glyph")).toBeTruthy();
    expect(screen.queryByTestId("daemon-status-chip")).toBeNull();
    expect(screen.queryByTestId("daemon-status-chip-label")).toBeNull();
    await fireEvent.click(screen.getByTestId("daemon-dialog-glyph"));
    expect(opened).toBe("host-ok");
  });

  it("anomaly: loud chip present and opens dialog", async () => {
    let opened: string | undefined;
    const store = mockStore({
      byHost: { "host-a": bootRefused },
      onSetDialogHost: (h) => {
        opened = h ?? undefined;
      },
    });
    render(() => (
      <DaemonStatusCtx.Provider value={store}>
        <FleetDaemonStatusChip host="host-a" />
      </DaemonStatusCtx.Provider>
    ));
    expect(screen.getByTestId("daemon-dialog-glyph")).toBeTruthy();
    expect(screen.getByTestId("daemon-status-chip-label").textContent).toBe(
      "boot refused",
    );
    await fireEvent.click(screen.getByTestId("daemon-status-chip"));
    expect(opened).toBe("host-a");
  });

  it("status={null} binding fails rendered assertion (mutation target)", () => {
    // Production FleetDaemonStatusChip reads store.byHost()[host].
    // Mutating it to status={null} paints unknown — this is the red.
    // (Direct DaemonStatusChip still paints; glance gate hides null/unknown.)
    render(() => <DaemonStatusChip status={null} />);
    expect(screen.getByTestId("daemon-status-chip-label").textContent).toBe(
      "daemon…",
    );
    // Contrasting: real status does not.
    cleanup();
    render(() => <DaemonStatusChip status={bootRefused} />);
    expect(screen.getByTestId("daemon-status-chip-label").textContent).toBe(
      "boot refused",
    );
  });
});

describe("U4.3 production glance placements (real TabHostGlance / HostCardGlance)", () => {
  const bootRefused = status({
    phase: "failed",
    anomaly: {
      kind: "boot-refused",
      detail: "d",
      message: "d",
    },
  });

  function assertNoNestedButtons(root: HTMLElement) {
    expect(root.querySelector("button button")).toBeNull();
    for (const btn of root.querySelectorAll("button")) {
      let p = btn.parentElement;
      while (p && p !== root) {
        expect(p.tagName).not.toBe("BUTTON");
        p = p.parentElement;
      }
    }
  }

  it("TabHostGlance: select + chip sibling controls, distinct actions", async () => {
    let selected = 0;
    let opened: string | undefined;
    const store = mockStore({
      byHost: { "tab-host": bootRefused },
      onSetDialogHost: (h) => {
        opened = h ?? undefined;
      },
    });
    // PRODUCTION component (TabChip mounts this) — not a hand-written mirror.
    const { container } = render(() => (
      <DaemonStatusCtx.Provider value={store}>
        <TabHostGlance
          host="tab-host"
          active={false}
          connectionKind="failed"
          alertCount={0}
          entryState={fakeEntryState("failed")}
          onSelect={() => {
            selected += 1;
          }}
          onClose={() => {}}
        />
      </DaemonStatusCtx.Provider>
    ));
    assertNoNestedButtons(container as HTMLElement);
    await fireEvent.click(screen.getByTestId("tab-select-tab-host"));
    expect(selected).toBe(1);
    expect(opened).toBeUndefined();
    await fireEvent.click(screen.getByTestId("daemon-status-chip"));
    expect(opened).toBe("tab-host");
    expect(selected).toBe(1);
  });

  it("TabHostGlance healthy: glyph present + dialog reachable + no loud chip", async () => {
    let opened: string | undefined;
    const store = mockStore({
      byHost: { "tab-ok": status({ phase: "connected" }) },
      onSetDialogHost: (h) => {
        opened = h ?? undefined;
      },
    });
    const { container } = render(() => (
      <DaemonStatusCtx.Provider value={store}>
        <TabHostGlance
          host="tab-ok"
          active={true}
          connectionKind="connected"
          alertCount={0}
          entryState={fakeEntryState("connected")}
          onSelect={() => {}}
          onClose={() => {}}
        />
      </DaemonStatusCtx.Provider>
    ));
    assertNoNestedButtons(container as HTMLElement);
    expect(screen.getByTestId("daemon-dialog-glyph")).toBeTruthy();
    expect(screen.queryByTestId("daemon-status-chip")).toBeNull();
    expect(screen.queryByTestId("daemon-status-chip-label")).toBeNull();
    await fireEvent.click(screen.getByTestId("daemon-dialog-glyph"));
    expect(opened).toBe("tab-ok");
  });

  it("HostCardGlance: select + chip sibling controls, distinct actions", async () => {
    let selected = 0;
    let opened: string | undefined;
    const store = mockStore({
      byHost: { "card-host": bootRefused },
      onSetDialogHost: (h) => {
        opened = h ?? undefined;
      },
    });
    // PRODUCTION component (HostCard mounts this) — not a hand-written mirror.
    const { container } = render(() => (
      <DaemonStatusCtx.Provider value={store}>
        <HostCardGlance
          host="card-host"
          connectionPhase="failed"
          alertCount={0}
          entryState={fakeEntryState("failed")}
          onSelect={() => {
            selected += 1;
          }}
        >
          <div>metrics</div>
        </HostCardGlance>
      </DaemonStatusCtx.Provider>
    ));
    assertNoNestedButtons(container as HTMLElement);
    await fireEvent.click(screen.getByTestId("host-card-select-card-host"));
    expect(selected).toBe(1);
    await fireEvent.click(screen.getByTestId("daemon-status-chip"));
    expect(opened).toBe("card-host");
    expect(selected).toBe(1);
  });

  it("HostCardGlance healthy: glyph present + dialog reachable + no loud chip", async () => {
    let opened: string | undefined;
    const store = mockStore({
      byHost: { "card-ok": status({ phase: "connected" }) },
      onSetDialogHost: (h) => {
        opened = h ?? undefined;
      },
    });
    const { container } = render(() => (
      <DaemonStatusCtx.Provider value={store}>
        <HostCardGlance
          host="card-ok"
          connectionPhase="connected"
          alertCount={0}
          entryState={fakeEntryState("connected")}
          onSelect={() => {}}
        >
          <div>metrics</div>
        </HostCardGlance>
      </DaemonStatusCtx.Provider>
    ));
    assertNoNestedButtons(container as HTMLElement);
    expect(screen.getByTestId("daemon-dialog-glyph")).toBeTruthy();
    expect(screen.queryByTestId("daemon-status-chip")).toBeNull();
    await fireEvent.click(screen.getByTestId("daemon-dialog-glyph"));
    expect(opened).toBe("card-ok");
  });

  it("anomaly glance surfaces paint the loud chip", () => {
    const store = mockStore({ byHost: { "tab-bad": bootRefused } });
    render(() => (
      <DaemonStatusCtx.Provider value={store}>
        <TabHostGlance
          host="tab-bad"
          active={false}
          connectionKind="failed"
          alertCount={0}
          entryState={fakeEntryState("failed")}
          onSelect={() => {}}
          onClose={() => {}}
        />
      </DaemonStatusCtx.Provider>
    ));
    expect(screen.getByTestId("daemon-dialog-glyph")).toBeTruthy();
    expect(screen.getByTestId("daemon-status-chip-label").textContent).toBe(
      "boot refused",
    );
  });

  it("production call sites mount the glance components (not inlined nests)", () => {
    expect(tabSrc).toMatch(/TabHostGlance/);
    expect(appSrc).toMatch(/HostCardGlance/);
    // MUTATION: nest FleetDaemonStatusChip inside the select button in
    // daemonHostGlance.tsx ⇒ rendered assertNoNestedButtons reds.
    expect(glanceSrc).toMatch(
      /<\/button>\s*<FleetDaemonStatusChip\s+host=\{props\.host\}\s*\/>/,
    );
    // Glyph is the durable healthy-path dialog entry (header + fleet).
    expect(appSrc).toMatch(/DaemonDialogGlyph/);
    expect(chipSrc).toMatch(/data-testid="daemon-dialog-glyph"/);
  });
});
