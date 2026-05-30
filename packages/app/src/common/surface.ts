/**
 * drishti surface — the shape served by the agent over stdio and
 * re-served by the parent over WebSocket.
 *
 * Two primitives carry the entire feature:
 *
 *   - `system`     — singleton cell with load averages, memory, uptime.
 *   - `processes`  — keyed collection (PID → per-process snapshot).
 *
 * The surface is **strictly read-only**: it exposes cells, collections,
 * and streams, but no procedures — there is no way to mutate the
 * monitored host through it.
 *
 * Plus a `connection` cell so the parent can stream "copying agent to
 * remote…" lifecycle to the browser while `nix copy` is in flight.
 */

import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import { z } from "zod";

const PidSchema = z.number().int().nonnegative();
const ProcessSchema = z.object({
  user: z.string(),
  cpuPct: z.number(),
  /** Resident set size in bytes — the absolute physical memory the
   *  process occupies. The headline memory number the UI shows; a ratio
   *  view can derive `rssBytes / system.memTotal` at the call site. */
  rssBytes: z.number(),
  command: z.string(),
  /** Current working directory. From `/proc/<pid>/cwd` on linux and a single
   *  batched `lsof -d cwd` on darwin. Empty string when unknown — kernel
   *  threads have no cwd, and other-user pids without root can't be resolved
   *  (EACCES on `/proc/<pid>/cwd` on linux; no `lsof` cwd line on darwin). */
  cwd: z.string(),
  /** Parent process id — `/proc/<pid>/stat` field 4 on linux, `ps -o
   *  ppid=` on darwin. 0 for pid 1 / the rare orphan whose parent has
   *  already reaped. */
  ppid: PidSchema,
  /** Single-char kernel state code: `R` running, `S` sleeping, `D`
   *  uninterruptible, `Z` zombie, `T` stopped, `I` idle, … `/proc/<pid>/stat`
   *  field 3 on linux; the first char of `ps -o state=` on darwin (its
   *  trailing flags like `+`/`s` are dropped). Empty when unknown. */
  state: z.string(),
  /** Nice value (scheduling priority, -20..19). `/proc/<pid>/stat` field 19
   *  on linux, `ps -o nice=` on darwin. */
  nice: z.number().int(),
  /** Thread count (`/proc/<pid>/stat` field 20), or null when the platform
   *  can't cheaply source it — darwin's `ps` has no per-process thread count.
   *  Null (not 0) so "unavailable" is distinct from a real count at the type
   *  level; a live linux process always has >= 1. */
  threads: z.number().int().positive().nullable(),
  /** Process start time as epoch milliseconds, or null when unknown. Derived
   *  on linux from the host boot time plus `/proc/<pid>/stat` field 22
   *  (start-ticks-since-boot); null on darwin, which has no cheap per-pid start
   *  source in the `ps` columns we read. Immutable per pid, so the poll loop
   *  excludes it from change detection. */
  startedAtMs: z.number().nullable(),
});

const CpuCoreSchema = z.object({
  /** Busy-percentage since the previous poll tick (0-100). */
  usagePct: z.number(),
  /** Reported clock speed in MHz (often a sticky max on Linux). */
  speedMHz: z.number(),
  model: z.string(),
});

/** Per-network-interface I/O. Keyed by NIC name (`eth0`, `en0`, …) in the
 *  `networkInterfaces` collection. Both a level (cumulative bytes since
 *  boot) and a rate (bytes/sec over the last poll window) — throughput is
 *  the headline number; the cumulative totals are the "how much has this
 *  link carried" context. Loopback is filtered out at the agent: it's
 *  intra-host traffic, not network I/O, and would otherwise dominate the
 *  list with constant noise. */
const NetInterfaceSchema = z.object({
  /** Cumulative bytes received since boot. */
  rxBytes: z.number(),
  /** Cumulative bytes transmitted since boot. */
  txBytes: z.number(),
  /** Receive throughput in bytes/sec over the last poll window. 0 on the
   *  first tick (no previous counters to delta against yet). */
  rxRate: z.number(),
  /** Transmit throughput in bytes/sec over the last poll window. */
  txRate: z.number(),
});
const SystemSchema = z.object({
  /** 1-minute, 5-minute, 15-minute load averages. */
  loadAvg: z.tuple([z.number(), z.number(), z.number()]),
  /** Bytes used / total — UI converts to GB. */
  memUsed: z.number(),
  memTotal: z.number(),
  /** Bytes used / total on the **root filesystem** (`/`), via `statfs("/")`
   *  in the agent. `diskUsed = (blocks − bfree) × bsize`, the bytes-occupied
   *  parity of `memUsed = memTotal − available` — so `diskPct` reuses the
   *  same `pctOf` "share of total" formula memory does.
   *
   *  ⚠ **Mount-selection policy: root `/` only.** Unlike memory (one
   *  authoritative host figure), a host has many filesystems and no single
   *  capacity aggregate; this scalar deliberately reports just `/`. A host
   *  that splits `/var`, `/nix`, or `/data` onto separate disks will not see
   *  those here — a per-mount view is a future `diskDevices` collection
   *  (mirroring `networkInterfaces`), not a reinterpretation of this field.
   *  Both 0 when the agent can't `statfs` (unknown platform) — `pctOf`
   *  guards the divide. */
  diskUsed: z.number(),
  diskTotal: z.number(),
  /** Seconds since boot. */
  uptime: z.number(),
  /** OS family — `linux` reads /proc/*, `darwin` reads sysctl. */
  os: z.enum(["linux", "darwin", "unknown"]),
  /** Resolved hostname inside the agent (parent shows this in the
   *  header chip — useful when the parent ssh'd by an alias). */
  hostname: z.string(),
  /** Agent's poll cadence in milliseconds — the UI displays this so
   *  the cadence is single-sourced at the agent (which actually owns
   *  the setInterval). */
  pollIntervalMs: z.number(),
});

/** Parent-to-agent link lifecycle.
 *
 *  ⚠ **Parent-only write authority.** The cell lives on the shared
 *  surface so the browser can subscribe to it via snapshot-then-delta,
 *  but the *value* is owned by the parent's `HostSession`. The agent
 *  has no visibility into the link from the inside (a process can't
 *  observe its own SSH transport state) and must NOT publish updates
 *  here — see the inert stub in `agent/main.ts`. Any direct-to-agent
 *  client would see `DEFAULT_CONNECTION` forever; that's by design,
 *  since direct-to-agent connections imply the link is local and
 *  always-up.
 *
 *  The browser subscribes via `useCell(connection)`, which yields the
 *  current value synchronously to a new subscriber — the overlay
 *  attaches before `connect()` returns and still sees the initial
 *  `connecting` state. */
const ConnectionSchema = z.object({
  /** Link phase. Mirrors `HostSession`'s `ConnectionState` 1:1 (the
   *  parent owns this — see above). `disconnected` is the transient gap
   *  between retry attempts; `failed` is terminal — the parent's
   *  reconnect loop gave up and won't retry without a manual
   *  `hosts.reconnect`. Splitting the two is the whole point: the UI can
   *  finally tell "reconnecting…" from "gave up, here's why". */
  state: z.enum([
    "copying",
    "connecting",
    "connected",
    "disconnected",
    "failed",
  ]),
  /** The error behind a `disconnected`/`failed` state, verbatim from the
   *  parent (`HostSession.lastError`). `null` while healthy. Free-form —
   *  the parent owns the vocabulary; the browser only renders it. */
  lastError: z.string().nullable(),
  /** Tail of the parent's link-lifecycle progress log (nix-copy output,
   *  ssh spawn, "reconnecting… (attempt N/5)"). Lets the overlay show
   *  live retry progress without the browser parsing it for control
   *  flow — it's display text, never a branch condition. Deliberately
   *  uncapped: the parent already trims the ring to a kolu-private bound,
   *  and re-asserting that constant here would couple this contract to a
   *  value drishti doesn't own — and reject valid frames if kolu ever
   *  raised it. The UI reads only a bounded tail (the overlay's last line;
   *  the failed-host card's last few), so the length is moot. */
  progressLines: z.array(z.string()),
});

export const DEFAULT_SYSTEM: z.infer<typeof SystemSchema> = {
  loadAvg: [0, 0, 0],
  memUsed: 0,
  memTotal: 0,
  diskUsed: 0,
  diskTotal: 0,
  uptime: 0,
  os: "unknown",
  hostname: "",
  pollIntervalMs: 0,
};

export const DEFAULT_CONNECTION: z.infer<typeof ConnectionSchema> = {
  state: "connecting",
  lastError: null,
  progressLines: [],
};

/** Snapshot-then-delta `Stream<>` shape — the bulk-friendly counterpart
 *  to the per-key `processes` collection. With 600+ PIDs, the
 *  collection's N+1 subscribes drip a row per round-trip over a
 *  high-latency `ssh` link; this stream yields the entire keyed map
 *  in one frame (snapshot) then per-tick delta sets. The UI consumes
 *  this for the htop table; the per-key `processes` collection stays
 *  on the surface for "watch one specific PID" use cases. */
const ProcessesSnapshotMessage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    entries: z.array(z.tuple([PidSchema, ProcessSchema])),
  }),
  z.object({
    kind: z.literal("delta"),
    upserts: z.array(z.tuple([PidSchema, ProcessSchema])),
    removes: z.array(PidSchema),
  }),
]);

/** One point in a host's metric history — CPU% and memory% at a wall-clock
 *  instant. Captured by the **parent** on each agent poll tick (the parent
 *  is the only tier that observes every tick regardless of which browser
 *  tabs are open) and retained in an in-memory ring for the life of the
 *  parent process. */
const MetricSampleSchema = z.object({
  /** Wall-clock capture time, epoch ms. */
  t: z.number(),
  /** Mean busy-percentage across all cores at capture (0-100). */
  cpu: z.number(),
  /** Memory used as a percentage of total at capture (0-100). */
  mem: z.number(),
  /** Root-filesystem used as a percentage of total at capture (0-100). */
  disk: z.number(),
});

/** Snapshot-then-delta `Stream<>` for the per-host metric-history ring —
 *  the same bulk-friendly shape as `processesSnapshot`. A new subscriber
 *  (a freshly-loaded browser, or a tab just switched to this host) gets the
 *  parent's entire ring in one `snapshot` frame, then one `delta` per poll
 *  tick. This is why history survives reloads and tab switches: the state
 *  lives in the parent, and every subscriber is re-seeded from it. */
const MetricHistoryMessage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    samples: z.array(MetricSampleSchema),
  }),
  z.object({
    kind: z.literal("delta"),
    sample: MetricSampleSchema,
  }),
]);

export const surface = defineSurface({
  cells: {
    system: {
      schema: SystemSchema,
      default: DEFAULT_SYSTEM,
    },
    connection: {
      schema: ConnectionSchema,
      default: DEFAULT_CONNECTION,
    },
  },
  collections: {
    processes: {
      keySchema: PidSchema,
      schema: ProcessSchema,
    },
    /** Per-core CPU usage — small-N (typical 4-32) `Collection<K,T>`.
     *  Each core is independently observable via the framework's
     *  per-key reactive identity, which is exactly the shape a
     *  "view N rows side by side" UI wants when N is small. */
    cpuCores: {
      keySchema: z.number().int().nonnegative(),
      schema: CpuCoreSchema,
    },
    /** Per-NIC network I/O — small-N keyed by interface name, the same
     *  `Collection<K,T>` shape as `cpuCores`. Each interface is
     *  independently observable; the UI renders one rx/tx row per NIC. */
    networkInterfaces: {
      keySchema: z.string(),
      schema: NetInterfaceSchema,
    },
  },
  streams: {
    processesSnapshot: {
      inputSchema: z.object({}),
      outputSchema: ProcessesSnapshotMessage,
    },
    /** Per-host CPU%/memory% history. Parent-owned, in-memory, bounded —
     *  see `MetricHistoryMessage`. The agent serves an inert empty stub
     *  (it keeps no history); the parent is the authoritative source. */
    metricHistory: {
      inputSchema: z.object({}),
      outputSchema: MetricHistoryMessage,
    },
  },
});

type SF = SurfaceTypes<typeof surface.spec>;

export type Pid = SF["collections"]["processes"]["Key"];
export type Process = SF["collections"]["processes"]["Value"];
export type CoreId = SF["collections"]["cpuCores"]["Key"];
export type CpuCore = SF["collections"]["cpuCores"]["Value"];
export type IfaceName = SF["collections"]["networkInterfaces"]["Key"];
export type NetInterface = SF["collections"]["networkInterfaces"]["Value"];
export type SystemInfo = SF["cells"]["system"]["Value"];
export type ConnectionInfo = SF["cells"]["connection"]["Value"];
export type ConnectionState = ConnectionInfo["state"];
export type ProcessesSnapshotMsg = SF["streams"]["processesSnapshot"]["Output"];
export type MetricSample = z.infer<typeof MetricSampleSchema>;
export type MetricHistoryMsg = SF["streams"]["metricHistory"]["Output"];
