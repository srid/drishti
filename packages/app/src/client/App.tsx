/**
 * Multi-host process monitor.
 *
 * `<MultiHostApp>` is the new root: it subscribes to the admin surface's
 * `hosts` collection, renders a `<TabStrip>` at the top, and mounts a
 * single `<HostView>` for the active tab. Switching tabs unmounts the
 * previous `HostView` (via `<Show keyed>`), tearing down its `system` /
 * `processesSnapshot` / `cpuCores` subscriptions through Solid's
 * `onCleanup`. Tab chips stay mounted across switches so their per-host
 * `connection` cell subscriptions stay live and the dot colors keep
 * updating.
 *
 * `<HostView>` is the prior single-host body, now parametric on `host`.
 * The per-host data shape (cells/collections/streams) is unchanged.
 */

import type { EntryState } from "@kolu/surface-map";
import { unenrolledStreamCall } from "@kolu/surface/client";
import { createSubscription, surfaceClientsHealth } from "@kolu/surface/solid";
import { STALE_PROCESS_CLOSE_CODE } from "@kolu/surface-app";
import { shellCommit } from "@kolu/surface-app/lifecycle";
import { SurfaceAppProvider, surfaceAppProbe } from "@kolu/surface-app/solid";
import { Meta, Title } from "@solidjs/meta";
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  type Setter,
  Show,
  type Signal,
  useContext,
} from "solid-js";
import {
  scopedByEntry,
  type ScopedByEntry,
  watchByEntry,
} from "@kolu/surface-map/client";
import type { AlertId, Alerts } from "drishti-common/alerts";
import {
  type CoreId,
  type CpuCore,
  DEFAULT_SYSTEM,
  type IfaceName,
  type MetricHistoryMsg,
  type MetricSample,
  type NetInterface,
  type Pid,
  type Process,
  type ProcessesSnapshotMsg,
  type SystemInfo,
} from "drishti-common";
import {
  type ConnectionInfo,
  type ConnectionState,
  DEFAULT_CONNECTION,
} from "drishti-common/browser";
import { disconnectedMessage, STATE, withElapsed } from "./connectionColors";
import { HostDot } from "./HostDot";
import type { View } from "./view";
import { searchForView, viewFromSearch } from "./urlState";
import {
  diskGb,
  diskPct,
  formatBytes,
  formatThroughput,
  formatUptime,
  memGb,
  memPct,
  pctOf,
} from "./metrics";
import { isActiveNic } from "./nic";
import { foldProcessesMessage } from "./processesStream";
import { coreUsageColor, processPctColor, usageBarColor } from "./usageColors";
import {
  CHART_MAX_POINTS,
  DEFAULT_HISTORY_WINDOW,
  downsample,
  HISTORY_RETENTION_MS,
  HISTORY_WINDOWS,
  type HistoryWindowKey,
  isHistoryWindowKey,
  type MetricKey,
  polylinePoints,
  pushSample,
  SPARKLINE_MAX_POINTS,
  WIDEST_HISTORY_WINDOW,
  windowMsFor,
  windowSlice,
} from "../common/history";
import { StatusFooter } from "./StatusFooter";
import { TabStrip } from "./TabStrip";
import { TransportOverlay } from "./TransportOverlay";
import { prefKey, readPref, writePref } from "./localStorageState";
import { brandColorForTheme } from "./brand";
import { APP_TITLE } from "./title";
import { createPageVisibility } from "@solid-primitives/page-visibility";
import { createVisibilityGate } from "./visibility";
import {
  applyTheme,
  initialTheme,
  otherTheme,
  THEME_KEY,
  type Theme,
} from "./theme";
import {
  adminClient,
  adminRpc,
  adminSocket,
  hostMap,
  hostRpc,
  notify,
  onHostMembershipError,
  rememberServerProcessId,
  surfaceAppClient,
} from "./wire";

const SORT_KEYS = ["cpu", "mem", "pid", "user"] as const;
type SortKey = (typeof SORT_KEYS)[number];

// The label for a raised alert id, read off the alert value the watcher hands
// back (the agent single-sources the word — "CPU"/"Memory"/"Disk"). Falls back
// to the bare id if the item somehow isn't in the value (it always is at a
// raise), so the notification title never renders "undefined".
function labelOf(value: Alerts, id: AlertId): string {
  return value.items.find((i) => i.id === id)?.label ?? id;
}

// The Badging API isn't in the DOM lib types; narrow `navigator` to the two
// methods drishti calls (both optional — absent on browsers without the API,
// where the alert count simply isn't badged). Feature-detected at the call site.
type BadgingNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

// Human labels for the kernel single-char process state codes (linux
// `/proc/<pid>/stat` field 3; the leading char of darwin `ps -o state=`).
// Codes outside this map (rare/transitional) render verbatim.
const PROCESS_STATE_LABELS: Record<string, string> = {
  R: "running",
  S: "sleeping",
  D: "uninterruptible",
  Z: "zombie",
  T: "stopped",
  t: "tracing stop",
  I: "idle",
  X: "dead",
  W: "paging",
};

// Which process row (if any) is expanded into the detail panel. Selection is
// a navigation concern owned by `HostView`, the same tier that owns the
// `processes` store and the filter/sort prefs — so `ProcessTable` stays a
// pure renderer (it never learns about selection) and `ProcessRow` reaches
// the signal through context for its click + highlight, mirroring how the
// app-level `view` signal threads down without widening every component's
// props. `toggle` re-selecting the open pid closes the panel.
type ProcessSelection = {
  selectedPid: Accessor<Pid | null>;
  toggle: (pid: Pid) => void;
};
const SelectionContext = createContext<ProcessSelection>();

// One host's per-host VIEW state, owned by the host map's `scopedByEntry` scope
// (padi W7): the expanded PID lives in the host's OWN reactive scope, retained
// across a tab switch and disposed when the host leaves the fleet — no longer a
// `createSignal` reset on every keyed `HostView` remount.
type HostScope = {
  selectedPid: Accessor<Pid | null>;
  setSelectedPid: Setter<Pid | null>;
};

// Bind a per-host preference to a signal: seed from localStorage and mirror
// every change back, keyed by host (`defer` skips the redundant write of the
// just-read seed). Computing the storage key once is the point — it removes
// the hazard of the seed-read and the write-back drifting to different keys.
// This is the signal-is-truth / store-is-projection shape of urlState's URL
// mirror, against a private store (localStorage) instead of the shareable
// one (the URL). It lives here, not in the framework-free localStorageState.ts
// (HostView is its only caller), so that module keeps its pure-I/O boundary.
function createPersistedSignal<T extends string>(
  pref: string,
  host: string,
  fallback: T,
  accept?: (raw: string) => boolean,
): Signal<T> {
  const key = prefKey(pref, host);
  const [value, setValue] = createSignal<T>(readPref(key, fallback, accept));
  createEffect(on(value, (v) => writePref(key, v), { defer: true }));
  return [value, setValue];
}

// ── Metric-history client primitive (shared by HostView and HostCard) ──
// The parent owns an in-memory CPU%/mem% ring per host, sampled every poll
// tick whether or not a tab is open. Both the full history panel and the
// fleet card sparkline drive off the same two steps — subscribe to that ring,
// then project it to the chart's polylines — so they live here, in one place,
// rather than being copied into each call site (where the snapshot/delta
// contract and the projection maths would drift apart).

// Accumulate a host's streamed metric ring into a signal: the full snapshot on
// connect, then one delta per tick, bounded to the server's retention. The
// stream lives off the passed `signal`, so the caller's controller (shared or
// its own) tears it down on unmount.
//
// `entry.rpc` no longer rides a dedicated per-host socket with its own
// `rawStream`/`health()` enrolment — every host's data is now key-folded
// over the ONE admin transport (`@kolu/surface-map`'s host map), and
// `Entry<ES>` carries no `.rawStream`/`.health()` of its own (see
// `HostDot.tsx`'s docstring). So this drops one level to the bare
// `createSubscription` + `unenrolledStreamCall` pair — the SAME primitive
// `processesSub` below already uses for the same reason (a raw streaming
// PROCEDURE, not a framework `.streams` primitive) — which owns its own
// `pending`/`error` without a health fact to join.
function subscribeMetricHistory(host: string): {
  history: Accessor<MetricSample[]>;
  streamError: Accessor<Error | null>;
} {
  const ctl = new AbortController();
  onCleanup(() => ctl.abort());
  const sub = createSubscription<MetricHistoryMsg, MetricSample[]>(
    () =>
      unenrolledStreamCall(
        hostRpc(host).surface.metricHistory.get,
        {},
        { signal: ctl.signal },
      ),
    {
      reduce: (prev, msg) =>
        msg.kind === "snapshot"
          ? msg.samples
          : pushSample(prev, msg.sample, HISTORY_RETENTION_MS),
      initial: [],
      signal: ctl.signal,
    },
  );
  return { history: () => sub() ?? [], streamError: () => sub.error() ?? null };
}

// Overlay text for a sparkline with no drawable point yet — the one place that
// distinguishes the two states an empty ring conflates: a feed that simply
// hasn't produced its first sample ("collecting…") from one whose stream has
// died ("unavailable"). Returns null once any sample exists, so the trace
// itself is what's shown.
function sparklinePlaceholder(
  latest: MetricSample | null,
  error: Error | null,
): string | null {
  if (latest !== null) return null;
  return error ? "unavailable" : "collecting…";
}

// The metric series the history chart and fleet-card sparkline draw, in
// render (and legend) order. This is the single source for "which series
// appear on screen": the projection (`projectHistory`), the sparkline
// polylines, and the legend chips all iterate it, so adding a series is one
// entry here rather than an edit fanned across each of those sites. The data
// layer that *produces* a series — the `MetricKey` union, the `MetricSample`
// schema, and `captureSample`'s per-series derivation — is necessarily
// separate (each series has its own source); this table owns only the
// rendering metadata.
//
// Tailwind's JIT scanner can't resolve interpolated class names, so each
// color is a complete literal (`text-emerald-500`, never `text-${c}-500`) —
// the strings must appear verbatim in source to survive the CSS build.
interface SeriesMeta {
  label: string;
  /** Polyline stroke, applied via `currentColor`. */
  line: string;
  /** Legend swatch fill. */
  swatch: string;
  /** Legend label text color (light / dark). */
  chip: string;
}

// Keyed by `MetricKey` and pinned with `satisfies Record<MetricKey, …>` so the
// compiler enforces the set in *both* directions: a metric added to the
// `MetricKey` union without an entry here fails to compile (rather than
// silently rendering a blank trace), and a stale key is rejected too. That
// exhaustiveness is what makes the `as Record<MetricKey, string>` cast in
// `projectHistory` provably safe.
const SERIES_META = {
  cpu: {
    label: "cpu",
    line: "text-emerald-500",
    swatch: "bg-emerald-500",
    chip: "text-emerald-600 dark:text-emerald-400",
  },
  mem: {
    label: "mem",
    line: "text-indigo-500",
    swatch: "bg-indigo-500",
    chip: "text-indigo-600 dark:text-indigo-400",
  },
  disk: {
    label: "disk",
    line: "text-amber-500",
    swatch: "bg-amber-500",
    chip: "text-amber-600 dark:text-amber-400",
  },
} satisfies Record<MetricKey, SeriesMeta>;

// The ordered list the projection, polylines, and legends iterate. Render
// (and legend) order follows the declaration order in `SERIES_META` above —
// `Object.entries` preserves string-key insertion order — so reordering the
// traces is a matter of reordering that object literal.
const SERIES: ReadonlyArray<{ key: MetricKey } & SeriesMeta> = (
  Object.entries(SERIES_META) as [MetricKey, SeriesMeta][]
).map(([key, meta]) => ({ key, ...meta }));

// Project a metric ring to one SVG polyline string per series plus the latest
// sample, for the given window. `now` anchors to the newest sample (not
// wall-clock) so the trace's right edge is always "latest data", never
// drifting ahead between ticks. Keeping the projection here — not in the
// renderer — lets the chart components stay pure, fed precomputed point
// strings (the same computed-props shape as Header / CpuStrip / NetStrip).
function projectHistory(
  history: Accessor<readonly MetricSample[]>,
  windowMs: Accessor<number>,
  maxPoints: number,
): {
  latest: Accessor<MetricSample | null>;
  points: Accessor<Record<MetricKey, string>>;
} {
  const latest = createMemo<MetricSample | null>(() => {
    const s = history();
    return s.length > 0 ? s[s.length - 1]! : null;
  });
  const now = createMemo(() => latest()?.t ?? 0);
  // Downsample to the draw budget BEFORE projecting: the widest 30m window is
  // up to 900 samples, but a trace only resolves a few hundred horizontal
  // pixels, so the per-tick `polylinePoints` work (and the `points` string the
  // SVG re-parses) is bounded to `maxPoints` per series instead of the ring.
  const windowed = createMemo(() =>
    downsample(windowSlice(history(), windowMs(), now()), maxPoints),
  );
  const points = createMemo<Record<MetricKey, string>>(() => {
    const w = windowed();
    const n = now();
    const ms = windowMs();
    return Object.fromEntries(
      SERIES.map((s) => [s.key, polylinePoints(w, s.key, n, ms)]),
    ) as Record<MetricKey, string>;
  });
  return { latest, points };
}

// The app root: wrap the multi-host tree in surface-app's headless provider so
// any descendant (the `StatusFooter`, the TabStrip's Pin-app button) reads
// build skew + the control-plane connection lifecycle via `useSurfaceApp()`.
//
//  - controlPlane = the surface-app client over the admin transport: surface-app
//    rides drishti's one global, always-open connection as a SIBLING surface
//    (kolu#1197/#1201). It carries the `buildInfo` cell + the `identity.info`
//    probe; the admin surface (host set) is its sibling on the same wire.
//  - clientCommit = the commit this client was built at, read off the no-store
//    HTML shell via `shellCommit()` (the global `surfaceApp()`/`buildSurfaceClient`
//    injects as `window.__SURFACE_APP_COMMIT__`, NOT a bundler define inside a
//    content-hashed asset — kolu#1319). The same value `surfaceAppServer()` reads
//    server-side, so skew is a real comparison.
//  - ws + probe = the admin socket's open/close paired with the shared
//    `surfaceAppProbe` helper (the scoped `surface.identity.info` probe), so a
//    reconnect to a *restarted* parent reads as a restart, not a transient drop.
//  - onProcessId = the turnkey `{ ws, probe }` source now publishes each observed
//    server `processId` (kolu#1231); we stash it in the `wire.ts` mutable the
//    admin/per-host URL thunks echo as the `pid` handshake param. The provider
//    also retires the admin socket itself on a stale-restart, so drishti no
//    longer hand-rolls either the probe-wrapper echo or the admin retirement —
//    the per-host sockets, which have no provider lifecycle, keep their own
//    close-listener retirement in `wire.ts`.
export default function App() {
  return (
    <SurfaceAppProvider
      controlPlane={surfaceAppClient()}
      clientCommit={shellCommit()}
      ws={adminSocket()}
      probe={() => surfaceAppProbe(surfaceAppClient())}
      // `wire.ts`'s `connectSurfaces` already wires the half-open watchdog over
      // this admin socket (minting the branded `{ live }` the clients require), so
      // the lifecycle opts ITS watchdog out — one watchdog on the socket, not two.
      // (The lifecycle mints no brand, so this is ownership coordination only.)
      heartbeat={false}
      onProcessId={rememberServerProcessId}
      restartCloseCode={STALE_PROCESS_CLOSE_CODE}
    >
      <TransportOverlay />
      <MultiHostApp />
    </SurfaceAppProvider>
  );
}

// How long a tab may sit hidden before its data views are torn down. Long
// enough that an alt-tab to copy a value keeps the fleet warm; short relative
// to the minutes/hours a genuinely-backgrounded tab spends idle.
const VISIBILITY_GRACE_MS = 20_000;

// Shown in place of the fleet/host body while the tab is paused (hidden past
// the grace window). Mounts no per-host subscriptions — that's the whole point
// — so a backgrounded tab stops decoding telemetry it can't display. The user
// only ever sees this for the one frame between re-focusing and the views
// remounting; it exists to make the paused state legible, not decorative.
function PausedView() {
  return (
    <div class="px-4 py-12 text-center text-gray-400 dark:text-gray-500">
      <div class="mb-1 text-sm">Paused</div>
      <div class="text-xs">Live updates resume when this tab is in view.</div>
    </div>
  );
}

function MultiHostApp() {
  const admin = adminClient();
  // Host membership + status is now the `@kolu/surface-map` host map's OWN
  // `entries` collection (`hostMap`, `wire.ts`) — the old hand-rolled
  // `admin.collections.hosts` is deleted.
  const hosts = hostMap.entries.use({ onError: onHostMembershipError });

  // Preserve insertion order: hostsStore guarantees first-occurrence
  // order, the server's pool seeds the map's `entries` in that order, and
  // the collection's keys stream is order-preserving. Sorting here would
  // silently override the upstream invariant.
  const hostList = createMemo<string[]>(() => [...hosts.keys()]);

  // Y6 (Leak D): the admin transport multiplexes TWO sibling surfaces — drishti's
  // own `admin` and surface-app — built by `surfaceClients`, each with its OWN
  // independent `health()`. `surfaceClientsHealth` folds them into ONE fact (the
  // multi-surface closure), so a degraded control-plane sibling surfaces in a
  // single read instead of N hand-assembled ones (each easy to forget — the
  // partial-gate hazard the fold exists to kill). This is the real CONSUMER of
  // that fold: kolu surfaces health per-cell via colocated toasts, so kolu's own
  // `surfaceClients` doesn't fold; drishti's always-open control plane is the
  // natural place to ask "is the fleet's spine healthy?" as one answer. Rendered
  // stale-while-degraded (drishti's policy) — a non-blocking strip, never blanking.
  // It DRINKS from the merged `live`: now that `wire.ts` threads the admin
  // socket's liveness through `surfaceClients`, a dead control-plane socket flips
  // the folded `live` false (the AND-reduce over both siblings) and the strip
  // says so — transport death wins over a per-sub error.
  // The admin control-plane health fact, folded once and read by BOTH the
  // degraded-strip memo below and the `StatusFooter`'s srv dot (`<HostStatusPip>`),
  // so the strip's "is the spine healthy?" verdict and the dot's green can't drift.
  const adminHealth = () =>
    surfaceClientsHealth({ admin, surfaceApp: surfaceAppClient() });
  const controlPlaneError = createMemo(() => {
    const h = adminHealth();
    if (!h.live) return "connection lost — reconnecting…";
    return h.subs.find((s) => s.error)?.error?.message ?? null;
  });

  // Page-visibility, sourced ONCE here (the single `visibilitychange`
  // subscription, SSR-safe) and fed to BOTH consumers — the becoming-visible
  // link re-probe just below and the data-view pause gate
  // (`createVisibilityGate`) — so there's no parallel listener to drift.
  const pageVisible = createPageVisibility();

  // Nudge the parent to re-probe every host link when the browser regains
  // connectivity (`online`) or the tab is refocused — the client-side companion
  // to the server's wake monitor. It catches the case the parent's clock-gap
  // detector can't: a brief network flap (café Wi-Fi dropping for a few seconds)
  // that never suspends the process. partysocket already reconnects these
  // loopback control sockets; this RPC reaches past them to the *agent* links
  // the parent holds over ssh.
  const recheckAllHosts = () => {
    void adminRpc()
      .hosts.recheck({})
      .catch((err) => console.error("hosts.recheck failed", err));
  };
  // Re-probe on the becoming-visible edge, off the shared signal (not a second
  // listener); `defer` skips the initial value so only real transitions fire.
  createEffect(
    on(
      pageVisible,
      (v) => {
        if (v) recheckAllHosts();
      },
      { defer: true },
    ),
  );
  window.addEventListener("online", recheckAllHosts);
  onCleanup(() => window.removeEventListener("online", recheckAllHosts));

  // The fleet overview is the default landing view — the "single pane of
  // glass" across every host. `view` holds the user's intent; the host
  // set it resolves against is owned by the admin collection. The initial
  // intent is read from the URL so a shared/bookmarked `?host=…` link opens
  // straight on that host (it resolves once the admin collection arrives).
  const [view, setView] = createSignal<View>(
    viewFromSearch(window.location.search),
  );

  // Mirror the selected view into the browser URL so every host — and the
  // fleet overview — has a shareable, bookmarkable address. `replaceState`
  // (not `pushState`) keeps the URL reflecting the current view without
  // growing the history stack: programmatic corrections — a removed host
  // resetting to fleet, or a malformed `?host=` normalising away — would
  // otherwise litter the back button with entries that all resolve to fleet.
  // Bound to `view` (intent), not `resolvedView`: while the admin collection
  // is still loading a deep-linked host isn't in the set yet, and binding to
  // the resolved value would rewrite the URL to fleet before the host arrives.
  // The guard skips redundant writes, including the no-op first run.
  createEffect(() => {
    const search = searchForView(view());
    if (search !== window.location.search) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${search}`,
      );
    }
  });
  // Resolve intent against the live host set: a host view whose host has
  // been removed falls back to the fleet overview rather than a blank
  // pane, and the fleet view always resolves to itself.
  const resolvedView = createMemo<View>(() => {
    const v = view();
    if (v.kind === "host" && hostList().includes(v.host)) return v;
    return { kind: "fleet" };
  });
  const selectedHost = createMemo<string | null>(() => {
    const v = resolvedView();
    return v.kind === "host" ? v.host : null;
  });

  // Per-host view state owned BY the host map (padi W7's `scopedByEntry`). Each
  // host's expanded PID is born in its own reactive scope, RETAINED across a tab
  // switch (restored verbatim on switch-back), and disposed when the host leaves
  // the fleet. This replaces the per-`HostView` `createSignal` that reset to
  // `null` on every keyed remount: "expanded pid lost on tab switch" dissolves
  // into the scope's retention. `selectedHost` (nullable — the fleet view selects
  // no host) stays the app-policy "which host is shown"; the framework owns the
  // per-host lifetime.
  const hostScopes: ScopedByEntry<string, HostScope> = scopedByEntry(
    hostMap,
    selectedHost,
    () => {
      const [selectedPid, setSelectedPid] = createSignal<Pid | null>(null);
      return { selectedPid, setSelectedPid };
    },
  );

  // ── Cross-host attention (kolu W5: watchByEntry + notify) ──────────────
  // The FRAMEWORK-GATE consumer of the new `alerts` cell: watch EVERY host's
  // alerts EAGERLY (a background host in trouble is exactly the one you need to
  // hear from) and fire an OS notification per newly-raised metric. Raise
  // detection is the framework's pure set-diff over the stable alert ids; this
  // runs under `MultiHostApp`'s reactive owner (watchByEntry throws otherwise)
  // and every per-host subscription tears down when the host leaves the fleet.
  // Permission is requested once (idempotent); delivery is a silent no-op until
  // granted, so an un-permissioned browser costs nothing.
  void notify.requestPermission();
  const alertsWatch = watchByEntry(
    hostMap,
    (e) => e.cells.alerts,
    (v) => v.items.map((i) => i.id),
    (host, raised, value) =>
      raised.forEach((id) =>
        void notify.show({
          tag: `${host}/${id}`,
          title: `${host}: ${labelOf(value, id)} alert`,
          data: { host, id },
        }),
      ),
  );
  // A notification click drills into the host it fired for — drishti's
  // host-select is just setting the `view` intent. Torn down with the app.
  onCleanup(notify.onClick(({ host }) => setView({ kind: "host", host })));

  // App badge = the COUNT OF HOSTS with any LIVE alert (drishti's own fold — a
  // host in trouble is one unit of attention, NOT the sum of its raised
  // metrics). A stale host (its link down) keeps its last value marked stale
  // and is deliberately NOT counted — a badge should reflect what's live. Guard
  // the Badging API (absent on some browsers) at the call site.
  createEffect(() => {
    const count = hostList().reduce((n, host) => {
      const w = alertsWatch.get(host);
      return n + (w?.kind === "live" && w.value.items.length > 0 ? 1 : 0);
    }, 0);
    if (typeof navigator === "undefined") return;
    const nav = navigator as BadgingNavigator;
    if (count > 0) void nav.setAppBadge?.(count);
    else void nav.clearAppBadge?.();
  });

  // Theme is global app chrome (like `view`), so it lives here, not per
  // host. The signal seeds from the attribute the pre-paint bootstrap in
  // index.html already applied; toggling flips the attribute and persists
  // the choice. `applyTheme` is the single writer of both DOM and storage.
  const [theme, setTheme] = createSignal<Theme>(initialTheme());
  // The signal is the source of truth; this effect projects it to the DOM
  // (via theme.ts, which owns the attribute/element detail) and persists
  // the choice — the same signal-is-truth / store-is-projection shape as
  // the per-host pref effects below. `defer` skips the redundant first
  // write: the pre-paint bootstrap in index.html already applied the
  // initial theme and storage already holds it.
  createEffect(
    on(
      theme,
      (t) => {
        applyTheme(t);
        writePref(THEME_KEY, t);
      },
      { defer: true },
    ),
  );
  const toggleTheme = () => setTheme(otherTheme(theme()));

  const onAdd = async (host: string): Promise<string | null> => {
    try {
      const res = await adminRpc().hosts.add({ host });
      if (!res.ok) return res.error ?? "add failed";
      setView({ kind: "host", host });
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  const onRemove = async (host: string) => {
    try {
      await adminRpc().hosts.remove({ host });
      // Drop the intent if the removed host was the selected one, so the
      // URL clears to the fleet path. (`resolvedView` already falls the
      // pane back to fleet; resetting the intent keeps the address in sync.)
      const v = view();
      if (v.kind === "host" && v.host === host) setView({ kind: "fleet" });
    } catch (err) {
      console.error(`remove ${host} failed`, err);
    }
  };

  // The app's identity is *which host this drishti runs on* — `drishti@<host>`.
  // The parent server (which knows `os.hostname()`) bakes that into the served
  // PWA manifest's name/short_name, so installing drishti from two hosts gives
  // two distinct, separately-labelled apps. The tab title is the same identity,
  // so we read it back from that one source — the manifest's `short_name` —
  // rather than re-deriving the host client-side (the browser never exposes
  // it). Falls back to the product title until the fetch resolves, or if it
  // fails (offline / blocked).
  const [appName] = createResource(async () => {
    try {
      const res = await fetch("/manifest.webmanifest");
      const m = (await res.json()) as { short_name?: string };
      return m.short_name ?? null;
    } catch {
      return null;
    }
  });

  // Pause the data views once the tab is backgrounded past the grace window —
  // see `createVisibilityGate`. 20s of grace lets a quick alt-tab keep the
  // subscriptions warm; a tab genuinely left in the background drops them.
  const visible = createVisibilityGate(pageVisible, VISIBILITY_GRACE_MS);

  return (
    // The app fills exactly one viewport (`h-dvh` + flex column) so the page
    // itself never scrolls — only the inner process list does, keeping the
    // host vitals pinned and avoiding a second, page-level scrollbar racing
    // the table's own. The bottom padding reserves room for the viewport-fixed
    // StatusFooter (plus the phone home-indicator inset it absorbs), so the
    // last table rows / fleet cards are never hidden under the bar. The
    // baseline is the shared --status-footer-height constant from styles.css.
    <div class="flex h-dvh flex-col bg-gray-50 p-4 pb-[calc(var(--status-footer-height)+env(safe-area-inset-bottom))] font-mono text-sm dark:bg-gray-950">
      {/* Reactive head, kolu's app-shell pattern over `@solidjs/meta`: the tab
          title is the server's own `drishti@<host>` identity (read from the
          served manifest), and the PWA `theme-color` tracks the *chosen* theme
          — the static media-query metas only knew the OS preference, so the
          address-bar tint disagreed with the page when the toggle overrode it. */}
      <Title>{appName() ?? APP_TITLE}</Title>
      <Meta name="theme-color" content={brandColorForTheme(theme())} />
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-gray-300 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <TabStrip
          hosts={hostList()}
          activeTab={resolvedView()}
          onSelectFleet={() => setView({ kind: "fleet" })}
          onSelect={(h) => setView({ kind: "host", host: h })}
          onAdd={onAdd}
          onRemove={onRemove}
          theme={theme()}
          onToggleTheme={toggleTheme}
        />
        {/* The folded control-plane health (Leak D): a degraded admin sibling
            shows a non-blocking strip, never blanking the fleet (drishti's
            stale-while-degraded policy). */}
        <Show when={controlPlaneError()}>
          <div class="border-b border-amber-500/40 bg-amber-500/10 px-4 py-1 text-xs text-amber-700 dark:text-amber-400">
            Control plane degraded — {controlPlaneError()}.
          </div>
        </Show>
        <Show
          when={hostList().length > 0}
          fallback={
            <div class="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
              <div class="mb-2 text-lg">No hosts configured</div>
              <div class="text-xs">Use the + button above to add one.</div>
            </div>
          }
        >
          {/* Pause the data views (and so every per-host system/cores/metric/
              process subscription) once the tab has been backgrounded past the
              grace window — a hidden tab can't show telemetry, so it shouldn't
              decode and reconcile it. The sockets stay warm in the wire cache,
              so returning re-subscribes and the parent re-seeds each snapshot. */}
          <Show when={visible()} fallback={<PausedView />}>
            <Show
              when={selectedHost()}
              fallback={
                <FleetView
                  hosts={hostList()}
                  onSelect={(h) => setView({ kind: "host", host: h })}
                />
              }
              keyed
            >
              {(host) => <HostView host={host} scopes={hostScopes} />}
            </Show>
          </Show>
        </Show>
      </div>
      <StatusFooter health={adminHealth} />
    </div>
  );
}

// ── Fleet overview: every host as a live summary card ──────────────────

// The aggregate "pane of glass". Each card subscribes to its host's
// `system` / `connection` cells and `cpuCores` collection — the same
// per-host sockets the tab chips already keep warm — so opening the
// overview costs subscriptions, not new connections. Clicking a card
// drills into that host's full htop body.
function FleetView(props: {
  hosts: readonly string[];
  onSelect: (host: string) => void;
}) {
  return (
    <div class="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2 lg:grid-cols-3">
      <For each={props.hosts}>
        {(host) => (
          <HostCard host={host} onSelect={() => props.onSelect(host)} />
        )}
      </For>
    </div>
  );
}

function HostCard(props: { host: string; onSelect: () => void }) {
  const entry = hostMap.entry(props.host);
  const system = entry.cells.system.use({});
  const connection = entry.cells.connection.use({});
  // The host's raised-alert set (kolu W5 `alerts` cell). A minimal pip on the
  // card surfaces "this host is in trouble" at a glance, alongside the OS
  // notification the app-scope `watchByEntry` fires — same source of truth.
  const alerts = entry.cells.alerts.use({});
  const alertCount = createMemo(() => alerts.value()?.items.length ?? 0);

  const sys = createMemo<SystemInfo>(() => system.value() ?? DEFAULT_SYSTEM);
  const state = createMemo<ConnectionState>(
    () => (connection.value() ?? DEFAULT_CONNECTION).phase,
  );
  // The dot + readiness gate read the host MAP's `EntryStatus` fact
  // (floored on real transport liveness by `connectSurfaceMap`) — the
  // per-host `SurfaceHealth`/`app.health()` this used to gate on no longer
  // exists now that every host rides the ONE admin transport. The status
  // WORD stays driven by the richer `ConnectionState` cell (copying vs
  // connecting vs the failure detail) — see `HostDot.tsx`'s docstring for
  // why the dot and the word now read two different facts.
  const entryState = createMemo<EntryState>(() => entry.state());
  // CPU% and the core count are read straight off the `system` cell — the agent
  // folds them in (`system.cpuPct` / `system.coreCount`). The card used to open
  // the per-key `cpuCores` collection (one value stream PER core PER host) just
  // to average it for one number; reading the aggregate cell drops the fleet's
  // entire O(hosts×cores) subscription fan-out. The per-core collection stays
  // for the host drill-in (CpuStrip), which actually renders a bar per core.
  const cpuPct = createMemo(() => sys().cpuPct);
  const coreCount = createMemo(() => sys().coreCount);
  const mem = createMemo(() => memPct(sys()));
  const memText = createMemo(() => {
    const gb = memGb(sys());
    return `${gb.used}/${gb.total} GB · ${mem().toFixed(0)}%`;
  });
  const disk = createMemo(() => diskPct(sys()));
  const diskText = createMemo(() => {
    const gb = diskGb(sys());
    return `/ · ${gb.used}/${gb.total} GB · ${disk().toFixed(0)}%`;
  });

  return (
    <button
      type="button"
      onClick={props.onSelect}
      class="flex flex-col gap-2 rounded border border-gray-200 bg-gray-50 p-3 text-left transition-colors hover:border-indigo-400 hover:bg-white dark:border-gray-800 dark:bg-gray-900/40 dark:hover:border-indigo-500 dark:hover:bg-gray-900"
    >
      <div class="flex items-center gap-2">
        <HostDot state={entryState} class="shrink-0" />
        <span class="truncate font-semibold" title={props.host}>
          {props.host}
        </span>
        <Show when={alertCount() > 0}>
          <span
            class="shrink-0 rounded-full bg-red-500/15 px-1.5 text-xs font-semibold text-red-600 dark:text-red-400"
            title={`${alertCount()} alert${alertCount() === 1 ? "" : "s"}`}
          >
            {alertCount()}
          </span>
        </Show>
        <span class={`ml-auto shrink-0 text-xs ${STATE[state()].text}`}>
          {state()}
        </span>
      </div>

      <Show
        when={entryState().kind === "connected"}
        fallback={
          <div class="py-3 text-center text-xs text-gray-400 dark:text-gray-500">
            {STATE[state()].label}
          </div>
        }
      >
        <CardMetric
          label="cpu"
          pct={cpuPct()}
          detail={`${cpuPct().toFixed(0)}% · ${coreCount()} cores`}
        />
        <CardMetric label="mem" pct={mem()} detail={memText()} />
        <CardMetric label="disk" pct={disk()} detail={diskText()} />
        <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>
            load{" "}
            <span class="font-semibold text-gray-700 dark:text-gray-300">
              {sys().loadAvg[0].toFixed(2)}
            </span>{" "}
            {sys().loadAvg[1].toFixed(2)} {sys().loadAvg[2].toFixed(2)}
          </span>
          <span>
            up {formatUptime(sys().uptime)} · {sys().os}
          </span>
        </div>
        <HostCardSparkline host={props.host} />
      </Show>
    </button>
  );
}

// The fleet card's glance sparkline. Mounted only inside the card's
// `<Show when={entryState.kind === "connected"}>`, so a connecting or
// disconnected host opens NO metricHistory stream and runs NO per-tick
// projection — the eager projection memos that used to recompute for every
// card regardless of liveness are gone. Pins the widest window (a
// glanceable trend, no picker) and downsamples to the sparkline's pixel
// budget so a 40px box is drawn from ~120 points, not the full 900-sample
// ring.
function HostCardSparkline(props: { host: string }) {
  const { history, streamError } = subscribeMetricHistory(props.host);
  const { latest, points } = projectHistory(
    history,
    () => windowMsFor(WIDEST_HISTORY_WINDOW),
    SPARKLINE_MAX_POINTS,
  );
  return (
    <div class="flex flex-col gap-0.5">
      <div class="flex items-center gap-2 text-xs text-gray-500">
        <span class="uppercase tracking-wide">{WIDEST_HISTORY_WINDOW}</span>
        <div class="ml-auto flex items-center gap-2">
          <For each={SERIES}>
            {(s) => (
              <span class={`flex items-center gap-1 ${s.chip}`}>
                <span class={`inline-block h-2 w-2 rounded-sm ${s.swatch}`} />
                {s.label}
              </span>
            )}
          </For>
        </div>
      </div>
      <Sparkline
        points={points()}
        placeholder={sparklinePlaceholder(latest(), streamError())}
        class="h-10"
      />
    </div>
  );
}

// One labelled metric row inside a host card: a label, a usage bar, and
// a detail string. Reuses the same UsageBar as the per-host header so the
// >85% red / >65% amber thresholds stay single-sourced.
function CardMetric(props: { label: string; pct: number; detail: string }) {
  return (
    <div class="flex flex-col gap-0.5">
      <div class="flex justify-between text-xs">
        <span class="uppercase tracking-wide text-gray-500">{props.label}</span>
        <span class="text-gray-500 dark:text-gray-400">{props.detail}</span>
      </div>
      <UsageBar pct={props.pct} />
    </div>
  );
}

// ── Per-host body (the prior single-host App, now parametric) ──────────

function HostView(props: {
  host: string;
  scopes: ScopedByEntry<string, HostScope>;
}) {
  // `hostMap.entry(...)` is a PURE lens over the ONE admin transport's
  // key-folded link — the same map the tab chip's dot reads. Multiple
  // consumers on one socket is the supported shape; oRPC multiplexes calls
  // per procedure-path on the wire, now further folded by `{ mapKey }`.
  const entry = hostMap.entry(props.host);

  // `system`/`connection` are void-input CELLS. `@kolu/surface-map`'s
  // entry-router transform folds a void-input member's envelope as
  // `{ mapKey }` — it OMITS the `input` field entirely (`define.ts`'s
  // `foldInput()` / `isVoidInput`), rather than the old `{ mapKey, input:
  // z.void() }` shape. That is what makes these subscriptions robust now: the
  // wire frame has no `input` key by construction, so nothing depends on a
  // JSON round-trip preserving an `undefined`-valued property or on zod
  // accepting a MISSING `z.void()` key — a leniency zod tightened in >=4.3.7.
  // drishti's `zod` therefore rides a normal `^4.3.6` range again (the exact
  // `4.3.6` pin this once needed is gone). `onError` stays wired here as a
  // defensive surface (not swallowed) rather than hanging silently, in case a
  // future dependency drift reintroduces this class of bug.
  const system = entry.cells.system.use({
    onError: (err) => console.error("system subscription failed", err),
  });
  const connection = entry.cells.connection.use({
    onError: (err) => console.error("connection subscription failed", err),
  });
  const entryState = createMemo<EntryState>(() => entry.state());

  // Re-arm the parent's session after it gave up (state === "failed").
  // Routed straight to the admin surface rather than through the root's
  // add/remove handlers: unlike those, reconnect has no view-state side
  // effect, so it needs nothing the root owns. Fire-and-forget — the
  // `connection` cell streams the resulting copying→connecting→connected
  // transition back on its own.
  const onReconnect = () => {
    void adminRpc()
      .hosts.reconnect({ host: props.host })
      .catch((err) => console.error(`reconnect ${props.host} failed`, err));
  };

  // The live process table, consumed as a declarative value-bearing reactive
  // subscription: `createSubscription` folds every snapshot|delta frame in-loop
  // (via `foldProcessesMessage`) into the full process map, replacing the
  // hand-rolled `unenrolledStreamCall` + `for await` loop this used to be. The
  // table renders FINE-GRAINED off `processes()` below (`processes()[pid].cpuPct`),
  // so an in-place `reconcile` leaf update re-notifies just that cell — reading
  // the whole map coarsely and copying it into a store would drop same-shape
  // deltas (the R8b lesson). `.streams.use()` exposes no `reduce`, so this
  // drops one level to `createSubscription` (same reactive family); the
  // AbortController stays only to abort the underlying stream on unmount.
  const processesCtl = new AbortController();
  onCleanup(() => processesCtl.abort());
  const processesSub = createSubscription<
    ProcessesSnapshotMsg,
    Record<Pid, Process>
  >(
    () =>
      // The bare `unenrolledStreamCall` is the right primitive HERE — it is
      // the raw stream FACTORY feeding `createSubscription`, which owns its
      // own pending/error (`processesSnapshot.get` is a surface PROCEDURE,
      // not a `.streams` primitive, so the framework has no bound hook for
      // it). There is no per-host `health()` fact left to join it to —
      // every host's data rides the ONE admin transport now — so a dead
      // process feed surfaces via this subscription's own reactive
      // `error()`, read below.
      unenrolledStreamCall(
        hostRpc(props.host).surface.processesSnapshot.get,
        {},
        { signal: processesCtl.signal },
      ),
    {
      reduce: foldProcessesMessage,
      initial: {},
      signal: processesCtl.signal,
    },
  );
  const processes = (): Record<Pid, Process> => processesSub() ?? {};

  // Which PID is expanded into the detail panel (null = none). A transient focus,
  // not a per-host persisted pref — but now OWNED per-host by the host-map scope,
  // so it survives a tab switch (restored verbatim on switch-back) instead of
  // resetting. Still cleared when its process exits (the effect just below) so the
  // panel never has to special-case a vanished pid.
  // Expanded PID — owned per-host by the host-map scope (survives tab-away). The
  // active host's scope is stable for this HostView's lifetime (a tab switch
  // remounts HostView with the new host's scope) and is defined by construction:
  // HostView only mounts for a live `selectedHost`, which the map has activated.
  const scope = props.scopes.active();
  if (scope === undefined)
    throw new Error("HostView: the active host has no scope");
  const { selectedPid, setSelectedPid } = scope;
  const toggleSelected = (pid: Pid) =>
    setSelectedPid((cur) => (cur === pid ? null : pid));

  // Clear a selection whose process has left the set. The `selected` memo
  // below also resolves to null mid-tick, but clearing the signal here keeps a
  // later-reused pid from silently re-opening the panel. Tracks only the
  // selected pid's slot (not its fields), so a cpu/mem tick doesn't re-run it.
  //
  // Gate on the subscription having yielded its FIRST frame (`!processesSub
  // .pending()`) — mirroring kolu's `pending()`-gated hydration in
  // `useSessionRestore.ts`. `processesSub` REMOUNTS on a host switch and starts
  // at its `initial: {}` (empty) with `pending() === true`; without this gate,
  // switching back would read the RETAINED per-host `selectedPid` against that
  // empty first frame and clear it BEFORE the first real snapshot arrives —
  // silently defeating the scopedByEntry adoption (the expanded PID surviving
  // tab-away). Once the first snapshot lands, `pending()` latches false and a
  // genuinely-exited pid still clears against the LOADED table.
  createEffect(() => {
    const pid = selectedPid();
    if (pid !== null && !processesSub.pending() && processes()[pid] === undefined)
      setSelectedPid(null);
  });

  // Escape closes the panel — the conventional dismiss key, wired once for the
  // host body and torn down with it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") setSelectedPid(null);
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  // Per-host UI preferences, persisted to localStorage and keyed by host.
  // These signals live in this keyed component, so each host restores its
  // own filter/sort/window on reload or tab switch — per-host scope falls
  // out of where the state already lives.
  const [filter, setFilter] = createPersistedSignal<string>(
    "filter",
    props.host,
    "",
  );
  const [sortKey, setSortKey] = createPersistedSignal<SortKey>(
    "sort",
    props.host,
    "cpu",
    (raw) => (SORT_KEYS as readonly string[]).includes(raw),
  );

  const currentSystem = createMemo(() => system.value() ?? DEFAULT_SYSTEM);
  const currentConnection = createMemo(
    () => connection.value() ?? DEFAULT_CONNECTION,
  );

  // The connecting/failed overlay for the MIRROR axis (backend↔remote) —
  // the fallback the connection-cell gate below renders while not yet
  // `connected`.
  const connectingView = () => (
    <ConnectingOverlay
      connection={currentConnection()}
      onReconnect={onReconnect}
    />
  );

  const allPids = createMemo<Pid[]>(() =>
    Object.keys(processes()).map((k) => Number(k)),
  );

  // `cpuCores`/`networkInterfaces` ride the collection `deltas` verb, which
  // is ALSO void-input at the entry-router fold — the same omitted-`input`
  // envelope `system`/`connection` ride above (see that comment; `onError`
  // was already wired here, unlike those, since these two pre-date the map
  // adoption).
  const cores = entry.collections.cpuCores.use({
    onError: (err) => console.error("cpuCores subscription failed", err),
  });
  const coreIds = createMemo<CoreId[]>(() =>
    [...cores.keys()].sort((a, b) => a - b),
  );

  const nics = entry.collections.networkInterfaces.use({
    onError: (err) =>
      console.error("networkInterfaces subscription failed", err),
  });
  // Stable, name-sorted identity array so <For> reuses NetCell DOM across
  // ticks instead of churning rows (same reasoning as coreIds / visiblePids).
  const ifaceNames = createMemo<IfaceName[]>(() =>
    [...nics.keys()].sort((a, b) => a.localeCompare(b)),
  );

  // `<For>` keys by reference identity (=== on array elements). Primitive
  // PIDs make a memo that returns the SAME numbers ([…1234, 1235…]) reuse
  // every existing row DOM — Solid only mounts new PIDs and unmounts gone
  // ones. Returning `{pid, proc}` objects (the prior shape) made *every*
  // tick allocate fresh row identities, so the whole table was torn down
  // and rebuilt per snapshot (43 k tr add/remove vs 28 text changes in
  // 6 s, observed). Field reads moved into <ProcessRow> below so per-cell
  // reactivity updates only the changed cpuPct/rssBytes text nodes.
  const visiblePids = createMemo<Pid[]>(() => {
    const q = filter().trim().toLowerCase();
    const pids = allPids();
    const key = sortKey();
    const filtered: Pid[] = [];
    const procs = processes();
    if (q.length === 0) {
      for (const pid of pids) {
        if (procs[pid] !== undefined) filtered.push(pid);
      }
    } else {
      for (const pid of pids) {
        const proc = procs[pid];
        if (proc === undefined) continue;
        if (
          String(pid).includes(q) ||
          proc.user.toLowerCase().includes(q) ||
          proc.command.toLowerCase().includes(q) ||
          proc.cwd.toLowerCase().includes(q)
        )
          filtered.push(pid);
      }
    }
    filtered.sort(pidComparator(key, procs));
    return filtered;
  });

  // ── Metric history (parent-owned ring, streamed in) ─────────────────
  // The CPU%/mem% history isn't sampled here — the parent owns an in-memory
  // ring per host and samples it on every poll tick (whether or not a tab is
  // open), so it survives reloads and tab switches.
  const [historyWindow, setHistoryWindow] =
    createPersistedSignal<HistoryWindowKey>(
      "window",
      props.host,
      DEFAULT_HISTORY_WINDOW,
      isHistoryWindowKey,
    );
  const windowMs = createMemo(() => windowMsFor(historyWindow()));

  // metricHistory owns its own teardown via this view's reactive owner —
  // see `subscribeMetricHistory` / `projectHistory`.
  const { history, streamError } = subscribeMetricHistory(props.host);
  const { latest: latestSample, points } = projectHistory(
    history,
    windowMs,
    CHART_MAX_POINTS,
  );

  // The currently-selected process resolved against the live store: null when
  // nothing is selected OR the selected pid has left the set. The clear-at-
  // source above normally beats this to it, but resolving here too keeps the
  // panel honest even mid-tick — it renders only a process that still exists.
  const selected = createMemo<{ pid: Pid; proc: Process } | null>(() => {
    const pid = selectedPid();
    if (pid === null) return null;
    const proc = processes()[pid];
    return proc === undefined ? null : { pid, proc };
  });

  return (
    <>
      <Header
        system={currentSystem()}
        connection={currentConnection()}
        entryState={entryState}
        count={allPids().length}
      />
      {/* The readiness gate is now just the connection CELL's own state — the
          per-host `SurfaceHealth` `<SurfaceGate>` used to fold (transport ∧
          every sub's pending/error) no longer exists as a per-host fact now
          that every host's data rides the ONE admin transport instead of its
          own socket. `connectingView` covers both the cold-connect and the
          not-yet-`connected` mirror cases the old fallback did; there is no
          separate "degraded" amber notice left to distinguish a live-but-
          erroring sub from a still-warming one — each subscription below
          already surfaces its OWN error via its `onError` callback. */}
      <Show
        when={currentConnection().phase === "connected"}
        fallback={connectingView()}
      >
        <HistoryChart
          points={points()}
          latest={latestSample()}
          streamError={streamError()}
          windowKey={historyWindow()}
          onWindow={setHistoryWindow}
        />
        <CpuStrip coreIds={coreIds()} getCore={(id) => cores.byKey(id)?.()} />
        <NetStrip
          ifaceNames={ifaceNames()}
          getNic={(name) => nics.byKey(name)?.()}
        />
        <FilterBar
          filter={filter()}
          onFilter={setFilter}
          visible={visiblePids().length}
          total={allPids().length}
        />
        <Show when={selected()}>
          {(s) => (
            <ProcessDetail
              pid={s().pid}
              process={s().proc}
              memTotal={currentSystem().memTotal}
              onClose={() => setSelectedPid(null)}
              onSelectParent={
                processes()[s().proc.ppid] !== undefined
                  ? () => setSelectedPid(s().proc.ppid)
                  : null
              }
              onKill={(signal) =>
                hostRpc(props.host).surface.process.kill({
                  pid: s().pid,
                  signal,
                })
              }
            />
          )}
        </Show>
        <SelectionContext.Provider
          value={{ selectedPid, toggle: toggleSelected }}
        >
          <ProcessTable
            pids={visiblePids()}
            processes={processes}
            sortKey={sortKey()}
            onSort={setSortKey}
          />
        </SelectionContext.Provider>
      </Show>
    </>
  );
}

// Compare two PIDs by looking the procs up directly in the store. Cells
// the comparator touches become tracked deps of the surrounding memo —
// that's intentional: when cpuPct changes, the sort order must change
// with it. Sorting ~500 numbers is microseconds; the prior bottleneck
// was the DOM rebuild, not the sort.
function pidComparator(
  key: SortKey,
  procs: Record<Pid, Process>,
): (a: Pid, b: Pid) => number {
  // visiblePids() pre-filters out missing entries, so the indexed
  // lookups in here are always defined — assert past noUncheckedIndexedAccess.
  if (key === "cpu")
    return (a, b) => procs[b]!.cpuPct - procs[a]!.cpuPct || a - b;
  if (key === "mem")
    return (a, b) => procs[b]!.rssBytes - procs[a]!.rssBytes || a - b;
  if (key === "user")
    return (a, b) => procs[a]!.user.localeCompare(procs[b]!.user) || a - b;
  return (a, b) => a - b;
}

function Header(props: {
  system: ReturnType<() => typeof DEFAULT_SYSTEM>;
  connection: ReturnType<() => typeof DEFAULT_CONNECTION>;
  entryState: Accessor<EntryState>;
  count: number;
}) {
  // The component body runs ONCE at mount — when props.system is still
  // DEFAULT_SYSTEM (memUsed/memTotal 0). Derive through createMemo so these
  // re-run on every system tick; a plain const would freeze the header's
  // memory readout at "0.0/0.0 GB (0%)" forever. Mirrors HostCard.
  const pct = createMemo(() => memPct(props.system));
  const gb = createMemo(() => memGb(props.system));
  const diskP = createMemo(() => diskPct(props.system));
  const diskG = createMemo(() => diskGb(props.system));
  return (
    <div class="border-b border-gray-200 dark:border-gray-800">
      <UsageBar pct={pct()} />
      <div class="flex items-center justify-between px-4 py-2">
        <div class="flex items-center gap-3">
          <span class="font-semibold">drishti</span>
          <span class="text-gray-400">·</span>
          <span>
            <span class="text-gray-500">host:</span>{" "}
            <span class="font-semibold">{props.system.hostname || "—"}</span>
          </span>
          <span
            class={`flex items-center gap-1.5 ${STATE[props.connection.phase].text}`}
          >
            <HostDot state={props.entryState} />
            {props.connection.phase}
          </span>
          <span class="text-gray-500">·</span>
          <span class="text-gray-500">
            {props.count} {props.count === 1 ? "process" : "processes"}
          </span>
        </div>
        <span class="text-xs text-gray-500">
          poll: every {(props.system.pollIntervalMs / 1000).toFixed(1)}s
        </span>
      </div>
      <div class="flex flex-wrap gap-4 border-t border-gray-100 px-4 py-1.5 text-xs text-gray-700 dark:border-gray-800 dark:text-gray-300">
        <span>
          load{" "}
          <span class="font-semibold">
            {props.system.loadAvg[0].toFixed(2)}
          </span>{" "}
          <span class="text-gray-400">
            {props.system.loadAvg[1].toFixed(2)}
          </span>{" "}
          <span class="text-gray-400">
            {props.system.loadAvg[2].toFixed(2)}
          </span>
        </span>
        <span>
          mem <span class="font-semibold">{gb().used}</span>
          <span class="text-gray-400">/{gb().total} GB</span>
          <span class="ml-1 text-gray-400">
            ({pct().toFixed(0)}%)
          </span>
        </span>
        <span>
          disk <span class="font-semibold">{diskG().used}</span>
          <span class="text-gray-400">/{diskG().total} GB</span>
          <span class="ml-1 text-gray-400">({diskP().toFixed(0)}%)</span>
        </span>
        <span>
          uptime{" "}
          <span class="font-semibold">{formatUptime(props.system.uptime)}</span>
        </span>
        <span>
          os <span class="font-semibold">{props.system.os}</span>
        </span>
      </div>
    </div>
  );
}

// The one usage-bar fill leaf: a width-driven block inside a track, with NO CSS
// transition. The width is reassigned every poll tick, so an ease never settles
// — it only lags the true reading by ~150ms and turns one unavoidable repaint
// into ~8 layout+paint frames per bar per tick. Routing every bar (host header,
// fleet card, per-core strip) through this single leaf means no copy of the
// markup can reintroduce `transition-all` on a live value. Color + track are
// passed in so the >85%/>65% usage thresholds and the per-core scale share it.
function Bar(props: { pct: number; colorClass: string; trackClass: string }) {
  return (
    <div class={props.trackClass}>
      <div
        class={`h-full ${props.colorClass}`}
        style={{ width: `${Math.min(100, props.pct).toFixed(1)}%` }}
      />
    </div>
  );
}

function UsageBar(props: { pct: number }) {
  return (
    <Bar
      pct={props.pct}
      colorClass={usageBarColor(props.pct)}
      trackClass="h-1 w-full bg-gray-100 dark:bg-gray-800"
    />
  );
}

function FilterBar(props: {
  filter: string;
  onFilter: (q: string) => void;
  visible: number;
  total: number;
}) {
  return (
    <MetricSection class="flex items-center gap-2">
      <input
        type="text"
        placeholder="filter pid / user / command / cwd"
        class="w-64 rounded border border-gray-300 bg-gray-50 px-2 py-0.5 text-xs focus:border-emerald-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800"
        value={props.filter}
        onInput={(e) => props.onFilter(e.currentTarget.value)}
      />
      <span class="text-xs text-gray-500">
        showing {props.visible} of {props.total}
      </span>
    </MetricSection>
  );
}

function ConnectingOverlay(props: {
  connection: ConnectionInfo;
  onReconnect: () => void;
}) {
  const c = () => props.connection;
  // The terminal-failure arm, keyed once so the FailedCard reads `error`/`log`
  // off a narrowed value instead of the raw union. `null` when the link isn't
  // failed, which the `<Show>` below treats as "render the connecting view".
  const failedArm = () => {
    const conn = c();
    return conn.phase === "failed" ? conn : null;
  };
  // The freshest parent progress line (e.g. "reconnecting in 4000ms…
  // (attempt 2/5)"). Display only — never parsed for control flow.
  const lastProgress = () => c().log.at(-1)?.line ?? null;
  // The pending-state headline. `disconnected` refines by cause
  // ("Host unreachable — retrying…" for a network fault); every other
  // state takes its static message. `cause` lives only on the `disconnected`
  // arm, so narrow on `.phase` before reading it.
  const statusMessage = () => {
    const conn = c();
    return conn.phase === "disconnected"
      ? disconnectedMessage(conn.cause)
      : STATE[conn.phase].message;
  };

  // Seconds elapsed in the *current* connection state, reset on every
  // state change so it counts time-in-this-phase rather than total. A
  // connect that drags ("Connecting… 18s") reads as abnormal before the
  // parent's connect watchdog trips it to `failed`.
  const [elapsedSec, setElapsedSec] = createSignal(0);
  createEffect(
    on(
      () => c().phase,
      (state) => {
        setElapsedSec(0);
        // Only the in-progress states render the counter — `pending` is
        // the canonical "is this state in-flight" flag, so consult it
        // rather than leave the interval running in `connected`/`failed`
        // where `elapsedSec()` is never read.
        if (!STATE[state].pending) return;
        const startedAt = performance.now();
        const id = setInterval(
          () =>
            setElapsedSec(Math.floor((performance.now() - startedAt) / 1000)),
          1000,
        );
        onCleanup(() => clearInterval(id));
      },
    ),
  );
  return (
    <div class="px-4 py-12 text-center text-gray-600 dark:text-gray-400">
      <Show
        when={failedArm()}
        fallback={
          <>
            <div class="mb-2 text-lg">
              {withElapsed(statusMessage(), elapsedSec())}
            </div>
            <Show
              when={lastProgress()}
              fallback={
                <div class="text-xs">
                  First connect provisions the agent closure via{" "}
                  <code>nix copy</code>. Subsequent connects reuse it.
                </div>
              }
            >
              {(line) => <div class="text-xs text-gray-500">{line()}</div>}
            </Show>
          </>
        }
      >
        {(f) => (
          <FailedCard
            lastError={f().error}
            progressLines={f().log.map((e) => e.line)}
            onReconnect={props.onReconnect}
          />
        )}
      </Show>
    </div>
  );
}

// Terminal-failure card: the real error, the captured connection log, and
// a button to re-arm the parent's session (the only recovery short of
// restarting drishti). Shown when `connection.state === "failed"`.
function FailedCard(props: {
  lastError: string | null;
  progressLines: readonly string[];
  onReconnect: () => void;
}) {
  // The tail of the parent/agent link log — the *actual* failure output
  // (nix-copy stderr, ssh auth errors, the give-up line). This replaces a
  // hardcoded "maybe your user isn't in trusted-users" tip that was shown
  // for every failure regardless of cause: a guess decoupled from the real
  // error buries it. `lastError` is the terse headline ("exited with code
  // 1"); the log carries the why.
  const logTail = createMemo(() => props.progressLines.slice(-8));
  return (
    <div class="mx-auto max-w-lg rounded border border-red-500/40 bg-red-500/5 p-4 text-left">
      <div class="mb-1 text-lg text-red-500">Couldn't reach this host</div>
      <div class="mb-2 text-xs text-gray-500">
        Gave up after repeated connection failures.
      </div>
      <Show when={props.lastError}>
        {(err) => (
          <pre class="mb-3 overflow-x-auto whitespace-pre-wrap rounded bg-gray-100 p-2 text-left text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            {err()}
          </pre>
        )}
      </Show>
      <Show when={logTail().length > 0}>
        <div class="mb-1 text-xs text-gray-500">Connection log</div>
        <pre class="mb-3 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-gray-100 p-2 text-left text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
          {logTail().join("\n")}
        </pre>
      </Show>
      <button
        type="button"
        onClick={props.onReconnect}
        class="rounded border border-gray-300 bg-gray-50 px-3 py-1 text-xs hover:border-emerald-500 dark:border-gray-700 dark:bg-gray-800"
      >
        ↻ Reconnect
      </button>
    </div>
  );
}

function ProcessTable(props: {
  pids: readonly Pid[];
  processes: Accessor<Record<Pid, Process>>;
  sortKey: SortKey;
  onSort: (k: SortKey) => void;
}) {
  return (
    // `flex-1 min-h-0` makes the table the single scroll region: it grows to
    // fill whatever the pinned vitals above leave, and `min-h-0` lets it shrink
    // below its (612-row) content so it — and only it — scrolls. The sibling
    // vitals keep their intrinsic `min-height: auto`, so they stay pinned.
    <div class="min-h-0 flex-1 overflow-y-auto">
      <table class="w-full">
        <thead class="sticky top-0 bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-900 dark:text-gray-400">
          <tr class="border-b border-gray-200 dark:border-gray-800">
            <SortableTh
              label="PID"
              align="right"
              active={props.sortKey === "pid"}
              onClick={() => props.onSort("pid")}
            />
            <SortableTh
              label="USER"
              align="left"
              active={props.sortKey === "user"}
              onClick={() => props.onSort("user")}
            />
            <SortableTh
              label="CPU%"
              align="right"
              active={props.sortKey === "cpu"}
              onClick={() => props.onSort("cpu")}
            />
            <SortableTh
              label="MEM"
              align="right"
              active={props.sortKey === "mem"}
              onClick={() => props.onSort("mem")}
            />
            <th class="px-3 py-1.5 text-left">COMMAND</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.pids}>
            {(pid) => (
              <ProcessRow pid={pid} processes={props.processes} />
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

// One row per PID. The row is mounted once per PID and unmounted only
// when the PID leaves the visible set; every snapshot tick only mutates
// the text/className of cells whose underlying field changed. The
// optional-chain on each field handles the one-frame window between
// "PID removed from store" and "<For> reconciles its removal" — without
// it Solid would throw on the undefined entry. Cells stay tracked
// per-field via Solid's store proxy.
function ProcessRow(props: {
  pid: Pid;
  processes: Accessor<Record<Pid, Process>>;
}) {
  const selection = useContext(SelectionContext);
  const proc = () => props.processes()[props.pid];
  const cpu = () => proc()?.cpuPct ?? 0;
  const rssBytes = () => proc()?.rssBytes ?? 0;
  const isSelected = () => selection?.selectedPid() === props.pid;
  return (
    <tr
      onClick={() => selection?.toggle(props.pid)}
      class={`cursor-pointer border-b border-gray-100 dark:border-gray-800/50 ${
        isSelected()
          ? "bg-emerald-50 dark:bg-emerald-900/30"
          : "hover:bg-gray-50 dark:hover:bg-gray-800/40"
      }`}
    >
      {/* The four leading columns shrink to their content via `w-px` +
          `whitespace-nowrap`: `w-px` makes each column's preferred width
          tiny so the auto-layout table collapses it to its (nowrap) content
          width, leaving COMMAND's `w-full` as the sole absorber of the row's
          slack. Without this, COMMAND's `max-w-0` caps its growth and the
          leftover width inflates USER instead; and an un-nowrapped MEM cell
          wraps "817.5 MB" onto two lines in the narrowed column. */}
      <td class="w-px whitespace-nowrap px-3 py-0.5 text-right tabular-nums">
        {props.pid}
      </td>
      <td class="w-px whitespace-nowrap px-3 py-0.5 text-left">
        {proc()?.user ?? ""}
      </td>
      <td
        class={`w-px whitespace-nowrap px-3 py-0.5 text-right tabular-nums ${processPctColor(cpu())}`}
      >
        {cpu().toFixed(1)}
      </td>
      <td class="w-px whitespace-nowrap px-3 py-0.5 text-right tabular-nums text-gray-700 dark:text-gray-300">
        {formatBytes(rssBytes())}
      </td>
      {/* COMMAND absorbs the row's residual width and ellipsizes at the cell
          edge. Both classes are load-bearing in `table-layout: auto`: `w-full`
          claims the leftover width after the fixed numeric columns, and
          `max-w-0` stops the `truncate` nowrap content from ballooning the cell
          past the card (the card clips horizontally, so an un-capped cell would
          run off-screen with no ellipsis). Dropping either one breaks it. */}
      <td class="w-full max-w-0 truncate px-3 py-0.5 text-left text-gray-700 dark:text-gray-300">
        <span>{proc()?.command ?? ""}</span>
        <Show when={proc()?.cwd}>
          {(cwd) => (
            <span class="ml-2 text-gray-400 dark:text-gray-500" title="cwd">
              @ {cwd()}
            </span>
          )}
        </Show>
      </td>
    </tr>
  );
}

// The short, glanceable name for a process: the basename of its first argv
// token. `/usr/bin/node --foo` → `node`. The panel's full `command` row still
// shows the whole string; this is just the header label.
function commandName(command: string): string {
  const first = command.split(" ")[0] ?? command;
  const base = first.split("/").pop() ?? first;
  return base || command;
}

// One label/value pair in the detail panel's grid. Returns the <dt>/<dd> as a
// fragment so they land as direct children of the surrounding two-column <dl>.
function DetailRow(props: { label: string; children: JSX.Element }) {
  return (
    <>
      <dt class="uppercase tracking-wide text-gray-500">{props.label}</dt>
      <dd class="text-gray-700 dark:text-gray-300">{props.children}</dd>
    </>
  );
}

// Expanded view of one selected process — a sibling of the table (not an
// overlay), rendered by `HostView` only while a row is selected. Pure
// renderer fed the resolved `Process`, so the phase-2 surface fields
// (ppid / state / nice / threads / startedAtMs) flow in through `props.process`
// with no signature change. The table truncates `command` with CSS and tucks
// `cwd` inline after an `@`; here both get a full untruncated line, alongside
// the exact cpu/memory numbers and a memory share of the host total.
function ProcessDetail(props: {
  pid: Pid;
  process: Process;
  memTotal: number;
  onClose: () => void;
  // Non-null when the parent process is still in the live set. Clicking the
  // ppid calls this to re-point the selection to the parent (highlighting its
  // row and swapping the panel). Null when the parent has left the set, or for
  // pid 1 / orphans (ppid 0) — the ppid renders as plain text in that case.
  //
  // Wired to an *unconditional* setSelectedPid, NOT the `toggle` that
  // `ProcessRow` uses — navigating to a parent must always re-point, never
  // close. It's a prop (not SelectionContext) because `ProcessDetail` is a
  // sibling of the table, rendered before the context provider in the tree.
  onSelectParent: (() => void) | null;
  // R7 (kolu #1505): signal this process. Forwarded browser → parent → (mirror
  // procedure stub) → agent → kill(pid). Resolves with the agent's `{ ok, error }`.
  onKill: (signal: "TERM" | "KILL") => Promise<{ ok: boolean; error?: string }>;
}) {
  const p = () => props.process;
  // Kill-action state: "idle" | "killing" | <error message to show inline>.
  const [killState, setKillState] = createSignal<string>("idle");
  const runKill = async (signal: "TERM" | "KILL"): Promise<void> => {
    setKillState("killing");
    try {
      const r = await props.onKill(signal);
      // On success the process leaves the live set and this panel unmounts; if it
      // lingers (EPERM, already gone), surface the agent's reason — never silent.
      setKillState(r.ok ? "idle" : (r.error ?? "kill failed"));
    } catch (err) {
      setKillState((err as Error).message);
    }
  };
  // Resident memory as a share of host RAM — the same guarded "part of a
  // total" formula `memPct` uses for the host header.
  const memShare = () => pctOf(p().rssBytes, props.memTotal);
  const stateLabel = () => {
    const s = p().state;
    if (s === "") return "—";
    const label = PROCESS_STATE_LABELS[s];
    return label ? `${label} (${s})` : s;
  };
  return (
    <div class="border-b border-gray-200 bg-emerald-50/50 px-4 py-3 dark:border-gray-800 dark:bg-emerald-900/10">
      <div class="mb-2 flex items-baseline justify-between gap-2">
        <div class="flex items-baseline gap-2">
          <span class="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
            {props.pid}
          </span>
          <span class="text-gray-400">·</span>
          <span class="font-semibold">{commandName(p().command)}</span>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          class="cursor-pointer rounded px-1 leading-none text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          title="Close (Esc)"
          aria-label="Close process details"
        >
          ✕
        </button>
      </div>
      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <DetailRow label="command">
          <span class="break-all">{p().command}</span>
        </DetailRow>
        <Show when={p().cwd}>
          <DetailRow label="cwd">
            <span class="break-all">{p().cwd}</span>
          </DetailRow>
        </Show>
        <DetailRow label="cpu">
          <span class="tabular-nums">{p().cpuPct.toFixed(1)}%</span>
        </DetailRow>
        <DetailRow label="memory">
          <span class="tabular-nums">
            {formatBytes(p().rssBytes)} · {memShare().toFixed(1)}%
          </span>
        </DetailRow>
        <DetailRow label="state">{stateLabel()}</DetailRow>
        <DetailRow label="parent">
          <Show
            when={props.onSelectParent}
            fallback={<span class="tabular-nums">{p().ppid}</span>}
          >
            {(onSelect) => (
              <button
                type="button"
                onClick={onSelect()}
                class="cursor-pointer tabular-nums text-emerald-700 hover:underline dark:text-emerald-400"
                title="Select parent process"
              >
                {p().ppid}
              </button>
            )}
          </Show>
        </DetailRow>
        <DetailRow label="nice">
          <span class="tabular-nums">{p().nice}</span>
        </DetailRow>
        <Show when={p().threads}>
          {(threads) => (
            <DetailRow label="threads">
              <span class="tabular-nums">{threads()}</span>
            </DetailRow>
          )}
        </Show>
        <Show when={p().startedAtMs}>
          {(ms) => (
            <DetailRow label="started">
              {new Date(ms()).toLocaleString()}
            </DetailRow>
          )}
        </Show>
      </dl>
      <div class="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => runKill("TERM")}
          disabled={killState() === "killing"}
          class="cursor-pointer rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
          title="Send SIGTERM to this process"
        >
          {killState() === "killing" ? "Killing…" : "Kill"}
        </button>
        <button
          type="button"
          onClick={() => runKill("KILL")}
          disabled={killState() === "killing"}
          class="cursor-pointer rounded px-2 py-0.5 text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
          title="Send SIGKILL (force kill)"
        >
          Force
        </button>
        <Show when={killState() !== "idle" && killState() !== "killing"}>
          <span class="text-xs text-red-600 dark:text-red-400">
            {killState()}
          </span>
        </Show>
      </div>
    </div>
  );
}

function SortableTh(props: {
  label: string;
  align: "left" | "right";
  active: boolean;
  onClick: () => void;
}) {
  const alignClass = () =>
    props.align === "right" ? "text-right" : "text-left";
  return (
    <th class={`px-3 py-1.5 ${alignClass()}`}>
      <button
        type="button"
        class={`cursor-pointer ${props.active ? "text-emerald-600 dark:text-emerald-400" : ""}`}
        onClick={props.onClick}
      >
        {props.label}
        {props.active ? " ▾" : ""}
      </button>
    </th>
  );
}

// The section scaffold every per-host strip sits in: a bottom border and
// the standard horizontal/vertical padding. Single-sourced here so the one
// "what a section looks like" decision can't drift across the CPU / network
// strips, the filter bar, and the history chart (which previously each
// repeated the class string). `class` appends layout the caller needs on
// the same element — e.g. the filter bar's flex row.
function MetricSection(props: { class?: string; children: JSX.Element }) {
  return (
    <div
      class={`border-b border-gray-200 px-4 py-2 dark:border-gray-800${props.class ? ` ${props.class}` : ""}`}
    >
      {props.children}
    </div>
  );
}

// Shared chrome for the per-key metric strips (CPU cores, NICs): the
// hide-when-empty guard, the bordered section, the uppercase label+count
// header, and the responsive grid that <For>s over a stable key array. The
// cells differ per metric, so the caller supplies both the items and the
// per-item renderer; only the grid columns vary between strips.
//
// `primary` is the opt-in collapse hook: items it rejects are hidden behind a
// "+N idle" toggle (collapsed by default) so a strip with dozens of always-
// zero entries doesn't crowd the layout. Omitting it (as CpuStrip does) shows
// every item, unchanged. The predicate may read reactive state — it's
// evaluated inside a memo, so the partition re-runs as items go active/idle.
function MetricStrip<T>(props: {
  label: string;
  items: readonly T[];
  gridClass: string;
  children: (item: T) => JSX.Element;
  primary?: (item: T) => boolean;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const shown = createMemo(() => {
    if (props.primary === undefined || expanded()) return props.items;
    return props.items.filter(props.primary);
  });
  const hidden = () => props.items.length - shown().length;
  return (
    <Show when={props.items.length > 0}>
      <MetricSection>
        <div class="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500">
          <span>
            {props.label} (
            {props.primary === undefined
              ? props.items.length
              : `${shown().length}/${props.items.length}`}
            )
          </span>
          <Show
            when={props.primary !== undefined && (hidden() > 0 || expanded())}
          >
            <button
              type="button"
              class="cursor-pointer normal-case text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded() ? "− hide idle" : `+${hidden()} idle`}
            </button>
          </Show>
        </div>
        <div class={`grid ${props.gridClass}`}>
          <For each={shown()}>{(item) => props.children(item)}</For>
        </div>
      </MetricSection>
    </Show>
  );
}

function CpuStrip(props: {
  coreIds: readonly CoreId[];
  getCore: (id: CoreId) => CpuCore | undefined;
}) {
  return (
    <MetricStrip
      label="CPU cores"
      items={props.coreIds}
      gridClass="grid-cols-4 gap-2 md:grid-cols-8"
    >
      {(id) => <CpuCoreCell id={id} get={() => props.getCore(id)} />}
    </MetricStrip>
  );
}

function CpuCoreCell(props: { id: CoreId; get: () => CpuCore | undefined }) {
  const core = createMemo(() => props.get());
  const pct = () => core()?.usagePct ?? 0;
  return (
    <div class="flex items-center gap-1 text-xs">
      <span class="w-6 shrink-0 text-gray-500 tabular-nums">c{props.id}</span>
      <Bar
        pct={pct()}
        colorClass={coreUsageColor(pct())}
        trackClass="h-2 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-gray-800"
      />
      <span class="w-10 shrink-0 text-right tabular-nums text-gray-700 dark:text-gray-300">
        {pct().toFixed(0)}%
      </span>
    </div>
  );
}

// Per-NIC network I/O strip — the throughput counterpart to CpuStrip.
// Mounts once per interface; each NetCell tracks only its own rx/tx
// fields, so a busy NIC's rate updates without re-rendering its siblings.
// Idle interfaces (no live throughput) collapse behind a toggle by default —
// hosts carry dozens of always-zero virtual NICs that would otherwise bury
// the few moving traffic.
function NetStrip(props: {
  ifaceNames: readonly IfaceName[];
  getNic: (name: IfaceName) => NetInterface | undefined;
}) {
  return (
    <MetricStrip
      label="network"
      items={props.ifaceNames}
      gridClass="grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3"
      primary={(name) => isActiveNic(props.getNic(name))}
    >
      {(name) => <NetCell name={name} get={() => props.getNic(name)} />}
    </MetricStrip>
  );
}

function NetCell(props: {
  name: IfaceName;
  get: () => NetInterface | undefined;
}) {
  const nic = createMemo(() => props.get());
  const rxRate = () => nic()?.rxRate ?? 0;
  const txRate = () => nic()?.txRate ?? 0;
  return (
    <div class="flex items-center gap-2 text-xs">
      <span class="w-20 shrink-0 truncate text-gray-500" title={props.name}>
        {props.name}
      </span>
      <span
        class="tabular-nums text-emerald-600 dark:text-emerald-400"
        title={`${formatBytes(nic()?.rxBytes ?? 0)} received total`}
      >
        ↓ {formatThroughput(rxRate())}
      </span>
      <span
        class="tabular-nums text-indigo-600 dark:text-indigo-400"
        title={`${formatBytes(nic()?.txBytes ?? 0)} transmitted total`}
      >
        ↑ {formatThroughput(txRate())}
      </span>
    </div>
  );
}

// Per-host time-series chart: one trace per `SERIES` entry (CPU%, memory%,
// disk%) over the selected window, drawn as overlaid SVG sparklines. Pure
// renderer — `HostView` owns the ring and projects it to the per-series
// `points` map, so this component only paints (the same computed-props shape
// as Header / CpuStrip). The viewBox is a fixed 0-100 grid (percentages on
// both axes), so `preserveAspectRatio="none"` lets the trace stretch to
// whatever width the panel happens to be; the strokes use
// `vector-effect="non-scaling-stroke"` to stay 1px crisp under that stretch.
function HistoryChart(props: {
  points: Record<MetricKey, string>;
  latest: MetricSample | null;
  streamError: Error | null;
  windowKey: HistoryWindowKey;
  onWindow: (k: HistoryWindowKey) => void;
}) {
  return (
    <MetricSection>
      <div class="mb-1 flex items-center justify-between gap-2">
        <div class="flex items-center gap-3 text-xs uppercase tracking-wide text-gray-500">
          <span>history</span>
          <For each={SERIES}>
            {(s) => (
              <span class={`flex items-center gap-1 normal-case ${s.chip}`}>
                <span class={`inline-block h-2 w-2 rounded-sm ${s.swatch}`} />
                {s.label}{" "}
                {props.latest ? `${props.latest[s.key].toFixed(0)}%` : "—"}
              </span>
            )}
          </For>
        </div>
        <DurationPicker selected={props.windowKey} onSelect={props.onWindow} />
      </div>
      <Sparkline
        points={props.points}
        placeholder={sparklinePlaceholder(props.latest, props.streamError)}
        class="h-24"
      />
    </MetricSection>
  );
}

// One overlaid polyline per `SERIES` entry — the shared visual primitive
// behind both the full history panel and the fleet card sparkline. The viewBox is a fixed
// 0-100 grid (percentages on both axes), so `preserveAspectRatio="none"` lets
// the trace stretch to whatever the caller sizes it (`class` sets the height);
// the strokes use `vector-effect="non-scaling-stroke"` to stay 1px crisp under
// that stretch. `placeholder` (when non-null) overlays a status word —
// "collecting…" before the first sample, "unavailable" on a dead feed — in
// place of the trace.
function Sparkline(props: {
  points: Record<MetricKey, string>;
  placeholder: string | null;
  class?: string;
}) {
  return (
    <div
      class={`relative w-full overflow-hidden rounded bg-gray-100 dark:bg-gray-800/50 ${props.class ?? ""}`}
    >
      <svg
        class="h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <For each={SERIES}>
          {(s) => (
            <polyline
              class={s.line}
              points={props.points[s.key]}
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          )}
        </For>
      </svg>
      <Show when={props.placeholder !== null}>
        <div class="absolute inset-0 flex items-center justify-center text-xs text-gray-400 dark:text-gray-500">
          {props.placeholder}
        </div>
      </Show>
    </div>
  );
}

// Segmented duration control — the time-range chips popular monitors put
// above their graphs. Drives the parent's window signal; the chart re-slices
// reactively, so switching is instant against the already-buffered samples.
function DurationPicker(props: {
  selected: HistoryWindowKey;
  onSelect: (k: HistoryWindowKey) => void;
}) {
  return (
    <div class="flex shrink-0 overflow-hidden rounded border border-gray-300 dark:border-gray-700">
      <For each={HISTORY_WINDOWS}>
        {(w) => (
          <button
            type="button"
            onClick={() => props.onSelect(w.key)}
            class={`px-2 py-0.5 text-xs tabular-nums ${
              props.selected === w.key
                ? "bg-emerald-500 text-white"
                : "text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            {w.key}
          </button>
        )}
      </For>
    </div>
  );
}
