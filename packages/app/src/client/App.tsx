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
  createEffect,
  createMemo,
  createSignal,
  For,
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
  type Pid,
  type Process,
} from "../common/surface";
import { TabStrip } from "./TabStrip";
import { adminClient, disposeHostSurface, surfaceForHost } from "./wire";

const STATE_COLOR: Record<ConnectionState, string> = {
  connected: "text-emerald-500",
  disconnected: "text-red-500",
  copying: "text-amber-500",
  connecting: "text-amber-500",
};

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

  const [activeHost, setActiveHost] = createSignal<string | null>(null);
  // Keep the active host in sync with the host set: pick the first if
  // none is selected yet, or fall back when the active one is removed.
  const resolvedActive = createMemo<string | null>(() => {
    const list = hostList();
    const current = activeHost();
    if (list.length === 0) return null;
    if (current !== null && list.includes(current)) return current;
    return list[0] ?? null;
  });

  const onAdd = async (host: string): Promise<string | null> => {
    try {
      const res = await admin.rpc.surface.hosts.add({ host });
      if (!res.ok) return res.error ?? "add failed";
      setActiveHost(host);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  const onRemove = async (host: string) => {
    try {
      await admin.rpc.surface.hosts.remove({ host });
      if (activeHost() === host) setActiveHost(null);
    } catch (err) {
      console.error(`remove ${host} failed`, err);
    }
  };

  return (
    <div class="min-h-screen bg-gray-50 p-4 font-mono text-sm dark:bg-gray-950">
      <div class="mx-auto max-w-6xl overflow-hidden rounded border border-gray-300 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <TabStrip
          hosts={hostList()}
          active={resolvedActive()}
          onSelect={(h) => setActiveHost(h)}
          onAdd={onAdd}
          onRemove={onRemove}
        />
        <Show
          when={resolvedActive()}
          fallback={
            <div class="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
              <div class="mb-2 text-lg">No hosts configured</div>
              <div class="text-xs">Use the + button above to add one.</div>
            </div>
          }
          keyed
        >
          {(host) => <HostView host={host} />}
        </Show>
      </div>
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
          for (const [pid, value] of msg.upserts) setProcesses(pid, value);
          for (const pid of msg.removes) setProcesses(pid, undefined!);
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
          proc.command.toLowerCase().includes(q)
        )
          filtered.push(pid);
      }
    }
    filtered.sort(pidComparator(key, processes));
    return filtered;
  });

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
        <CpuStrip coreIds={coreIds()} getCore={(id) => cores.byKey(id)?.()} />
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
  const memPct = () => {
    const total = props.system.memTotal;
    return total > 0 ? (100 * props.system.memUsed) / total : 0;
  };
  const memGb = () => ({
    used: (props.system.memUsed / 1e9).toFixed(1),
    total: (props.system.memTotal / 1e9).toFixed(1),
  });
  const uptimeFmt = () => {
    const u = props.system.uptime;
    const d = Math.floor(u / 86400);
    const h = Math.floor((u % 86400) / 3600);
    const m = Math.floor((u % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };
  return (
    <div class="border-b border-gray-200 dark:border-gray-800">
      <UsageBar pct={memPct()} />
      <div class="flex items-center justify-between px-4 py-2">
        <div class="flex items-center gap-3">
          <span class="font-semibold">drishti</span>
          <span class="text-gray-400">·</span>
          <span>
            <span class="text-gray-500">host:</span>{" "}
            <span class="font-semibold">{props.system.hostname || "—"}</span>
          </span>
          <span class={STATE_COLOR[props.connection.state]}>
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
          mem <span class="font-semibold">{memGb().used}</span>
          <span class="text-gray-400">/{memGb().total} GB</span>
          <span class="ml-1 text-gray-400">({memPct().toFixed(0)}%)</span>
        </span>
        <span>
          uptime <span class="font-semibold">{uptimeFmt()}</span>
        </span>
        <span>
          os <span class="font-semibold">{props.system.os}</span>
        </span>
      </div>
    </div>
  );
}

function UsageBar(props: { pct: number }) {
  const colour = () => {
    if (props.pct > 85) return "bg-red-500";
    if (props.pct > 65) return "bg-amber-500";
    return "bg-emerald-500";
  };
  return (
    <div class="h-1 w-full bg-gray-100 dark:bg-gray-800">
      <div
        class={`h-full transition-all ${colour()}`}
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
        placeholder="filter pid / user / command"
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

function ConnectingOverlay(props: { state: string }) {
  const msg = () =>
    ({
      copying: "Copying agent to remote…",
      connecting: "Connecting…",
      disconnected: "Disconnected. Retrying…",
    })[props.state] ?? "Initializing…";
  return (
    <div class="px-4 py-12 text-center text-gray-600 dark:text-gray-400">
      <div class="mb-2 text-lg">{msg()}</div>
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
        class={`px-3 py-0.5 text-right tabular-nums ${pctClass(cpu())}`}
      >
        {cpu().toFixed(1)}
      </td>
      <td
        class={`px-3 py-0.5 text-right tabular-nums ${pctClass(mem())}`}
      >
        {mem().toFixed(1)}
      </td>
      <td class="max-w-md truncate px-3 py-0.5 text-left text-gray-700 dark:text-gray-300">
        {proc()?.command ?? ""}
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

function pctClass(pct: number): string {
  if (pct > 50) return "font-semibold text-red-500";
  if (pct > 10) return "text-amber-500";
  return "text-gray-700 dark:text-gray-400";
}

function CpuStrip(props: {
  coreIds: readonly CoreId[];
  getCore: (id: CoreId) => CpuCore | undefined;
}) {
  return (
    <Show when={props.coreIds.length > 0}>
      <div class="border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <div class="mb-1 text-xs uppercase tracking-wide text-gray-500">
          CPU cores ({props.coreIds.length})
        </div>
        <div class="grid grid-cols-4 gap-2 md:grid-cols-8">
          <For each={props.coreIds}>
            {(id) => <CpuCoreCell id={id} get={() => props.getCore(id)} />}
          </For>
        </div>
      </div>
    </Show>
  );
}

function CpuCoreCell(props: { id: CoreId; get: () => CpuCore | undefined }) {
  const core = createMemo(() => props.get());
  const pct = () => core()?.usagePct ?? 0;
  const barColor = createMemo(() => {
    const p = pct();
    if (p > 80) return "bg-red-500";
    if (p > 50) return "bg-amber-500";
    return "bg-emerald-500";
  });
  return (
    <div class="flex items-center gap-1 text-xs">
      <span class="w-6 shrink-0 text-gray-500 tabular-nums">c{props.id}</span>
      <div class="h-2 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
        <div
          class={`h-full transition-all ${barColor()}`}
          style={{ width: `${Math.min(100, pct()).toFixed(1)}%` }}
        />
      </div>
      <span class="w-10 shrink-0 text-right tabular-nums text-gray-700 dark:text-gray-300">
        {pct().toFixed(0)}%
      </span>
    </div>
  );
}
