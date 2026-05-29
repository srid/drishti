/**
 * drishti surface — the shape served by the agent over stdio and
 * re-served by the parent over WebSocket.
 *
 * Three primitives carry the entire feature:
 *
 *   - `system`     — singleton cell with load averages, memory, uptime.
 *   - `processes`  — keyed collection (PID → per-process snapshot).
 *   - `kill`       — imperative procedure (the only mutation).
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
  /** Current working directory. Empty string when unknown — kernel
   *  threads have no cwd, other-user pids hit EACCES on `/proc/<pid>/cwd`,
   *  and darwin has no cheap per-pid cwd source so it's blank there. */
  cwd: z.string(),
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
  state: z.enum(["copying", "connecting", "connected", "disconnected"]),
});

export const DEFAULT_SYSTEM: z.infer<typeof SystemSchema> = {
  loadAvg: [0, 0, 0],
  memUsed: 0,
  memTotal: 0,
  uptime: 0,
  os: "unknown",
  hostname: "",
  pollIntervalMs: 0,
};

export const DEFAULT_CONNECTION: z.infer<typeof ConnectionSchema> = {
  state: "connecting",
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
  procedures: {
    process: {
      kill: {
        input: z.object({
          pid: PidSchema,
          signal: z.enum(["TERM", "KILL", "HUP", "INT"]).default("TERM"),
        }),
        output: z.object({ ok: z.boolean() }),
      },
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
