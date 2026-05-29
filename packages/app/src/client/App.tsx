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

import { streamCall } from "@kolu/surface/client";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  type ConnectionState,
  type CoreId,
  type CpuCore,
  DEFAULT_CONNECTION,
  DEFAULT_SYSTEM,
  type IfaceName,
  type NetInterface,
  type Pid,
  type Process,
  type SystemInfo,
} from "../common/surface";
import { STATE } from "./connectionColors";
import type { View } from "./view";
import { searchForView, viewFromSearch } from "./urlState";
import {
  averageCoreUsage,
  formatBytes,
  formatThroughput,
  formatUptime,
  memGb,
  memPct,
} from "./metrics";
import { coreUsageColor, processPctColor, usageBarColor } from "./usageColors";
import {
  DEFAULT_HISTORY_WINDOW,
  HISTORY_RETENTION_MS,
  HISTORY_WINDOWS,
  type HistoryWindowKey,
  polylinePoints,
  pushSample,
  type Sample,
  windowMsFor,
  windowSlice,
} from "./history";
import { TabStrip } from "./TabStrip";
import { adminClient, disposeHostSurface, surfaceForHost } from "./wire";

type SortKey = "cpu" | "mem" | "pid" | "user";

export default function App() {
  const admin = adminClient();
  const hosts = admin.collections.hosts.use({
    onError: (err) => console.error("admin.hosts subscription failed", err),
  });

  // Preserve insertion order: hostsStore guarantees first-occurrence
  // order, the server's registry seeds the admin collection in that
  // order, and the admin collection's keys stream is order-preserving.
  // Sorting here would silently override the upstream invariant.
  const hostList = createMemo<string[]>(() => [...hosts.keys()]);

  // Drive per-host socket disposal from the parent that owns the admin
  // subscription, NOT from inside `TabChip`. The chip is pure display;
  // putting `disposeHostSurface` in its `onCleanup` would make a view
  // component the authoritative trigger for transport-lifetime events
  // (and routing dispose through `wire.ts` subscribing to admin would
  // complect the transport module with the admin schema). This effect
  // diffs the host set against the previous tick and disposes any
  // socket whose host is no longer present.
  let prevHosts: ReadonlySet<string> = new Set();
  createEffect(
    on(hostList, (current) => {
      const next = new Set(current);
      for (const host of prevHosts) {
        if (!next.has(host)) disposeHostSurface(host);
      }
      prevHosts = next;
    }),
  );

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

  const onAdd = async (host: string): Promise<string | null> => {
    try {
      const res = await admin.rpc.surface.hosts.add({ host });
      if (!res.ok) return res.error ?? "add failed";
      setView({ kind: "host", host });
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  const onRemove = async (host: string) => {
    try {
      await admin.rpc.surface.hosts.remove({ host });
      // Drop the intent if the removed host was the selected one, so the
      // URL clears to the fleet path. (`resolvedView` already falls the
      // pane back to fleet; resetting the intent keeps the address in sync.)
      const v = view();
      if (v.kind === "host" && v.host === host) setView({ kind: "fleet" });
    } catch (err) {
      console.error(`remove ${host} failed`, err);
    }
  };

  return (
    <div class="min-h-screen bg-gray-50 p-4 font-mono text-sm dark:bg-gray-950">
      <div class="mx-auto max-w-6xl overflow-hidden rounded border border-gray-300 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <TabStrip
          hosts={hostList()}
          activeTab={resolvedView()}
          onSelectFleet={() => setView({ kind: "fleet" })}
          onSelect={(h) => setView({ kind: "host", host: h })}
          onAdd={onAdd}
          onRemove={onRemove}
        />
        <Show
          when={hostList().length > 0}
          fallback={
            <div class="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
              <div class="mb-2 text-lg">No hosts configured</div>
              <div class="text-xs">Use the + button above to add one.</div>
            </div>
          }
        >
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
            {(host) => <HostView host={host} />}
          </Show>
        </Show>
      </div>
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
    <div class="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
      <For each={props.hosts}>
        {(host) => (
          <HostCard host={host} onSelect={() => props.onSelect(host)} />
        )}
      </For>
    </div>
  );
}

function HostCard(props: { host: string; onSelect: () => void }) {
  const app = surfaceForHost(props.host);
  const system = app.cells.system.use({});
  const connection = app.cells.connection.use({});
  const cores = app.collections.cpuCores.use({
    onError: (err) => console.error("cpuCores subscription failed", err),
  });

  const sys = createMemo<SystemInfo>(() => system.value() ?? DEFAULT_SYSTEM);
  const state = createMemo<ConnectionState>(
    () => (connection.value() ?? DEFAULT_CONNECTION).state,
  );
  // coreCount and cpuPct share a single cores.keys() iteration so the
  // detail string in CardMetric doesn't need a second spread.
  const coreCount = createMemo(() => [...cores.keys()].length);
  const cpuPct = createMemo(() =>
    averageCoreUsage(
      [...cores.keys()].map((id) => cores.byKey(id)?.()?.usagePct ?? 0),
    ),
  );
  const mem = createMemo(() => memPct(sys()));
  const memText = createMemo(() => {
    const gb = memGb(sys());
    return `${gb.used}/${gb.total} GB · ${mem().toFixed(0)}%`;
  });

  return (
    <button
      type="button"
      onClick={props.onSelect}
      class="flex flex-col gap-2 rounded border border-gray-200 bg-gray-50 p-3 text-left transition-colors hover:border-indigo-400 hover:bg-white dark:border-gray-800 dark:bg-gray-900/40 dark:hover:border-indigo-500 dark:hover:bg-gray-900"
    >
      <div class="flex items-center gap-2">
        <span
          class={`inline-block h-2 w-2 shrink-0 rounded-full ${STATE[state()].dotBg} ${STATE[state()].pending ? "animate-pulse" : ""}`}
        />
        <span class="truncate font-semibold" title={props.host}>
          {props.host}
        </span>
        <span class={`ml-auto shrink-0 text-xs ${STATE[state()].text}`}>
          {state()}
        </span>
      </div>

      <Show
        when={state() === "connected"}
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
      </Show>
    </button>
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

function HostView(props: { host: string }) {
  // `surfaceForHost` returns the cached client — the same instance the
  // tab chip is using for the `connection` cell. Multiple consumers on
  // one socket is the supported shape; oRPC multiplexes calls per
  // procedure-path on the wire.
  const app = surfaceForHost(props.host);

  const system = app.cells.system.use({});
  const connection = app.cells.connection.use({});

  const [processes, setProcesses] = createStore<Record<Pid, Process>>({});
  const ctl = new AbortController();
  onCleanup(() => ctl.abort());
  void (async () => {
    try {
      const stream = await streamCall(
        app.rpc.surface.processesSnapshot.get,
        {},
        { signal: ctl.signal },
      );
      for await (const msg of stream) {
        if (msg.kind === "snapshot") {
          const next: Record<Pid, Process> = {};
          for (const [pid, value] of msg.entries) next[pid] = value;
          setProcesses(reconcile(next));
        } else {
          // Wrap the per-PID setProcesses calls in a single batch so the
          // downstream visiblePids memo, the <For> reconciler, and every
          // per-cell reactive read fire ONCE per delta, not once per PID.
          // Without batch(), a 470-PID tick re-runs each dependent up to
          // 470 times, leaving Solid's <For> shuffling tr nodes through
          // a long sequence of intermediate orderings before settling.
          batch(() => {
            for (const [pid, value] of msg.upserts) setProcesses(pid, value);
            for (const pid of msg.removes) setProcesses(pid, undefined!);
          });
        }
      }
    } catch (err) {
      if (!ctl.signal.aborted)
        console.error("processesSnapshot stream failed", err);
    }
  })();

  const [filter, setFilter] = createSignal("");
  const [sortKey, setSortKey] = createSignal<SortKey>("cpu");

  const currentSystem = createMemo(() => system.value() ?? DEFAULT_SYSTEM);
  const currentConnection = createMemo(
    () => connection.value() ?? DEFAULT_CONNECTION,
  );

  const allPids = createMemo<Pid[]>(() =>
    Object.keys(processes).map((k) => Number(k)),
  );

  const cores = app.collections.cpuCores.use({
    onError: (err) => console.error("cpuCores subscription failed", err),
  });
  const coreIds = createMemo<CoreId[]>(() =>
    [...cores.keys()].sort((a, b) => a - b),
  );

  const nics = app.collections.networkInterfaces.use({
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
  // reactivity updates only the changed cpuPct/memPct text nodes.
  const visiblePids = createMemo<Pid[]>(() => {
    const q = filter().trim().toLowerCase();
    const pids = allPids();
    const key = sortKey();
    const filtered: Pid[] = [];
    if (q.length === 0) {
      for (const pid of pids) {
        if (processes[pid] !== undefined) filtered.push(pid);
      }
    } else {
      for (const pid of pids) {
        const proc = processes[pid];
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
    filtered.sort(pidComparator(key, processes));
    return filtered;
  });

  // ── Ephemeral metric history (per-host, in-memory) ──────────────────
  // A time-bounded ring of CPU%/mem% samples feeding the time-series
  // chart. Sampled on a timer at the host's own poll cadence so points
  // are evenly spaced regardless of when individual cells/collections
  // happen to fire; ticks while disconnected are skipped, leaving an
  // honest gap. The ring lives and dies with this HostView mount — it is
  // never persisted (the in-memory-ring decision from the feature plan).
  const [history, setHistory] = createSignal<Sample[]>([]);
  const [historyWindow, setHistoryWindow] =
    createSignal<HistoryWindowKey>(DEFAULT_HISTORY_WINDOW);
  const windowMs = createMemo(() => windowMsFor(historyWindow()));

  // Re-arm the sampler whenever the poll cadence changes (it's 0 until the
  // first `system` tick, then the agent's real interval). Reads inside the
  // timer callback are untracked — it just snapshots the latest values.
  createEffect(
    on(
      () => currentSystem().pollIntervalMs,
      (pollMs) => {
        const intervalMs = pollMs > 0 ? pollMs : 2000;
        const id = setInterval(() => {
          if (currentConnection().state !== "connected") return;
          const cpu = averageCoreUsage(
            coreIds().map((cid) => cores.byKey(cid)?.()?.usagePct ?? 0),
          );
          setHistory((prev) =>
            pushSample(
              prev,
              { t: Date.now(), cpu, mem: memPct(currentSystem()) },
              HISTORY_RETENTION_MS,
            ),
          );
        }, intervalMs);
        onCleanup(() => clearInterval(id));
      },
    ),
  );

  // Project the ring to the chart's two SVG polylines here — not inside
  // HistoryChart — so the component stays a pure renderer fed precomputed
  // point strings, the same computed-props shape as Header / CpuStrip /
  // NetStrip. `chartNow` anchors to the newest sample so the trace's right
  // edge is always "latest data", not wall-clock drifting ahead of the
  // last point between ticks.
  const latestSample = createMemo<Sample | null>(() => {
    const s = history();
    return s.length > 0 ? s[s.length - 1]! : null;
  });
  const chartNow = createMemo(() => latestSample()?.t ?? 0);
  const windowedSamples = createMemo(() =>
    windowSlice(history(), windowMs(), chartNow()),
  );
  const cpuPoints = createMemo(() =>
    polylinePoints(windowedSamples(), "cpu", chartNow(), windowMs()),
  );
  const memPoints = createMemo(() =>
    polylinePoints(windowedSamples(), "mem", chartNow(), windowMs()),
  );

  const killProcess = async (pid: number, signal: "TERM" | "KILL") => {
    try {
      await app.rpc.surface.process.kill({ pid, signal });
    } catch (err) {
      console.error(`kill ${pid} ${signal} failed`, err);
    }
  };

  return (
    <>
      <Header
        system={currentSystem()}
        connection={currentConnection()}
        count={allPids().length}
      />
      <Show
        when={currentConnection().state === "connected"}
        fallback={<ConnectingOverlay state={currentConnection().state} />}
      >
        <HistoryChart
          cpuPoints={cpuPoints()}
          memPoints={memPoints()}
          latest={latestSample()}
          hasSamples={history().length > 0}
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
        <ProcessTable
          pids={visiblePids()}
          processes={processes}
          sortKey={sortKey()}
          onSort={setSortKey}
          onKill={killProcess}
        />
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
    return (a, b) => procs[b]!.memPct - procs[a]!.memPct || a - b;
  if (key === "user")
    return (a, b) => procs[a]!.user.localeCompare(procs[b]!.user) || a - b;
  return (a, b) => a - b;
}

function Header(props: {
  system: ReturnType<() => typeof DEFAULT_SYSTEM>;
  connection: ReturnType<() => typeof DEFAULT_CONNECTION>;
  count: number;
}) {
  // Pure derivations cached once per render — props.system is a reactive
  // read that re-runs this component body when it changes, so these are
  // computed once per system tick, not once per JSX expression.
  const pct = memPct(props.system);
  const gb = memGb(props.system);
  return (
    <div class="border-b border-gray-200 dark:border-gray-800">
      <UsageBar pct={pct} />
      <div class="flex items-center justify-between px-4 py-2">
        <div class="flex items-center gap-3">
          <span class="font-semibold">drishti</span>
          <span class="text-gray-400">·</span>
          <span>
            <span class="text-gray-500">host:</span>{" "}
            <span class="font-semibold">{props.system.hostname || "—"}</span>
          </span>
          <span class={STATE[props.connection.state].text}>
            ● {props.connection.state}
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
          mem <span class="font-semibold">{gb.used}</span>
          <span class="text-gray-400">/{gb.total} GB</span>
          <span class="ml-1 text-gray-400">
            ({pct.toFixed(0)}%)
          </span>
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

function UsageBar(props: { pct: number }) {
  return (
    <div class="h-1 w-full bg-gray-100 dark:bg-gray-800">
      <div
        class={`h-full transition-all ${usageBarColor(props.pct)}`}
        style={{ width: `${Math.min(100, props.pct).toFixed(1)}%` }}
      />
    </div>
  );
}

function FilterBar(props: {
  filter: string;
  onFilter: (q: string) => void;
  visible: number;
  total: number;
}) {
  return (
    <div class="flex items-center gap-2 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
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
    </div>
  );
}

function ConnectingOverlay(props: { state: ConnectionState }) {
  return (
    <div class="px-4 py-12 text-center text-gray-600 dark:text-gray-400">
      <div class="mb-2 text-lg">{STATE[props.state].message}</div>
      <div class="text-xs">
        First connect provisions the agent closure via <code>nix copy</code>.
        Subsequent connects reuse it.
      </div>
    </div>
  );
}

function ProcessTable(props: {
  pids: readonly Pid[];
  processes: Record<Pid, Process>;
  sortKey: SortKey;
  onSort: (k: SortKey) => void;
  onKill: (pid: number, signal: "TERM" | "KILL") => void;
}) {
  return (
    <div class="max-h-[70vh] overflow-y-auto">
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
              label="MEM%"
              align="right"
              active={props.sortKey === "mem"}
              onClick={() => props.onSort("mem")}
            />
            <th class="px-3 py-1.5 text-left">COMMAND</th>
            <th class="px-3 py-1.5 text-right" />
          </tr>
        </thead>
        <tbody>
          <For each={props.pids}>
            {(pid) => (
              <ProcessRow
                pid={pid}
                processes={props.processes}
                onKill={props.onKill}
              />
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
  processes: Record<Pid, Process>;
  onKill: (pid: number, signal: "TERM" | "KILL") => void;
}) {
  const proc = () => props.processes[props.pid];
  const cpu = () => proc()?.cpuPct ?? 0;
  const mem = () => proc()?.memPct ?? 0;
  return (
    <tr class="border-b border-gray-100 hover:bg-gray-50 dark:border-gray-800/50 dark:hover:bg-gray-800/40">
      <td class="px-3 py-0.5 text-right tabular-nums">{props.pid}</td>
      <td class="px-3 py-0.5 text-left">{proc()?.user ?? ""}</td>
      <td
        class={`px-3 py-0.5 text-right tabular-nums ${processPctColor(cpu())}`}
      >
        {cpu().toFixed(1)}
      </td>
      <td
        class={`px-3 py-0.5 text-right tabular-nums ${processPctColor(mem())}`}
      >
        {mem().toFixed(1)}
      </td>
      <td class="max-w-md truncate px-3 py-0.5 text-left text-gray-700 dark:text-gray-300">
        <span>{proc()?.command ?? ""}</span>
        <Show when={proc()?.cwd}>
          {(cwd) => (
            <span class="ml-2 text-gray-400 dark:text-gray-500" title="cwd">
              @ {cwd()}
            </span>
          )}
        </Show>
      </td>
      <td class="px-3 py-0.5 text-right">
        <button
          type="button"
          class="rounded border border-gray-300 px-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-gray-700 dark:text-red-400 dark:hover:bg-red-950/40"
          onClick={() => props.onKill(props.pid, "TERM")}
          title="Send SIGTERM"
        >
          kill
        </button>
      </td>
    </tr>
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

// Shared chrome for the per-key metric strips (CPU cores, NICs): the
// hide-when-empty guard, the bordered section, the uppercase label+count
// header, and the responsive grid that <For>s over a stable key array. The
// cells differ per metric, so the caller supplies both the items and the
// per-item renderer; only the grid columns vary between strips.
function MetricStrip<T>(props: {
  label: string;
  items: readonly T[];
  gridClass: string;
  children: (item: T) => JSX.Element;
}) {
  return (
    <Show when={props.items.length > 0}>
      <div class="border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <div class="mb-1 text-xs uppercase tracking-wide text-gray-500">
          {props.label} ({props.items.length})
        </div>
        <div class={`grid ${props.gridClass}`}>
          <For each={props.items}>{(item) => props.children(item)}</For>
        </div>
      </div>
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
      <div class="h-2 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
        <div
          class={`h-full transition-all ${coreUsageColor(pct())}`}
          style={{ width: `${Math.min(100, pct()).toFixed(1)}%` }}
        />
      </div>
      <span class="w-10 shrink-0 text-right tabular-nums text-gray-700 dark:text-gray-300">
        {pct().toFixed(0)}%
      </span>
    </div>
  );
}

// Per-NIC network I/O strip — the throughput counterpart to CpuStrip.
// Mounts once per interface; each NetCell tracks only its own rx/tx
// fields, so a busy NIC's rate updates without re-rendering its siblings.
function NetStrip(props: {
  ifaceNames: readonly IfaceName[];
  getNic: (name: IfaceName) => NetInterface | undefined;
}) {
  return (
    <MetricStrip
      label="network"
      items={props.ifaceNames}
      gridClass="grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3"
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

// Per-host time-series chart: CPU% and memory% over the selected window,
// drawn as two overlaid SVG sparklines. Pure renderer — `HostView` owns the
// ring and projects it to the `cpuPoints` / `memPoints` strings, so this
// component only paints (the same computed-props shape as Header / CpuStrip).
// The viewBox is a fixed 0-100 grid (percentages on both axes), so
// `preserveAspectRatio="none"` lets the trace stretch to whatever width the
// panel happens to be; the strokes use `vector-effect="non-scaling-stroke"`
// to stay 1px crisp under that stretch.
function HistoryChart(props: {
  cpuPoints: string;
  memPoints: string;
  latest: Sample | null;
  hasSamples: boolean;
  windowKey: HistoryWindowKey;
  onWindow: (k: HistoryWindowKey) => void;
}) {
  return (
    <div class="border-b border-gray-200 px-4 py-2 dark:border-gray-800">
      <div class="mb-1 flex items-center justify-between gap-2">
        <div class="flex items-center gap-3 text-xs uppercase tracking-wide text-gray-500">
          <span>history</span>
          <span class="flex items-center gap-1 normal-case text-emerald-600 dark:text-emerald-400">
            <span class="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
            cpu {props.latest ? `${props.latest.cpu.toFixed(0)}%` : "—"}
          </span>
          <span class="flex items-center gap-1 normal-case text-indigo-600 dark:text-indigo-400">
            <span class="inline-block h-2 w-2 rounded-sm bg-indigo-500" />
            mem {props.latest ? `${props.latest.mem.toFixed(0)}%` : "—"}
          </span>
        </div>
        <DurationPicker selected={props.windowKey} onSelect={props.onWindow} />
      </div>
      <div class="relative h-24 w-full overflow-hidden rounded bg-gray-100 dark:bg-gray-800/50">
        <svg
          class="h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polyline
            class="text-emerald-500"
            points={props.cpuPoints}
            fill="none"
            stroke="currentColor"
            stroke-width="1"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
          <polyline
            class="text-indigo-500"
            points={props.memPoints}
            fill="none"
            stroke="currentColor"
            stroke-width="1"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <Show when={!props.hasSamples}>
          <div class="absolute inset-0 flex items-center justify-center text-xs text-gray-400 dark:text-gray-500">
            collecting…
          </div>
        </Show>
      </div>
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
            {w.label}
          </button>
        )}
      </For>
    </div>
  );
}
