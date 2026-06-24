/**
 * drishti surface — the shape served by the agent over stdio and
 * re-served by the parent over WebSocket.
 *
 * Two primitives carry the entire feature:
 *
 *   - `system`     — singleton cell with load averages, memory, uptime.
 *   - `processes`  — keyed collection (PID → per-process snapshot).
 *
 * One imperative escape hatch: the `process.kill` **procedure** — the
 * first *forwarded procedure* on a mirrored surface (kolu #1505, R7). It
 * runs on the agent (the host that owns the pids) and the parent forwards
 * the browser's call to it through `mirrorRemoteSurface`'s total-dual
 * procedure stub; everything else is read-only cells/collections/streams.
 *
 * Plus a `connection` cell so the parent can stream "copying agent to
 * remote…" lifecycle to the browser while `nix copy` is in flight.
 */

import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import {
  type ConnectionInfo,
  type ConnectionState,
  connectionCell,
  DEFAULT_CONNECTION,
  type FailureCause,
} from "@kolu/surface-nix-host/connection";
import { z } from "zod";

// Re-export the connection-cell types so drishti modules keep importing them
// from `drishti-common` (the canonical surface module) rather than reaching
// into `@kolu/surface-nix-host/connection` directly. The cell itself — schema,
// default, and the parent-only-write authority — is now owned upstream
// (kolu #1568); drishti composes the shared `connectionCell` into its surface.
export {
  type ConnectionInfo,
  type ConnectionState,
  DEFAULT_CONNECTION,
  type FailureCause,
};

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

// ⚠ **Parent-to-agent link lifecycle — owned upstream (kolu #1568).**
// The connection-health cell (schema, gate-closed `DEFAULT_CONNECTION`, and
// the parent-only-write / read-only-over-the-wire authority) now lives in
// `@kolu/surface-nix-host/connection` as the composable `connectionCell`. It
// is byte-identical in shape to drishti's former local `ConnectionSchema`
// (the five link phases, nullable `lastError`, nullable `network|remote`
// `failureCause`, `progressLines` string tail). drishti spreads the shared
// descriptor into its surface below and re-exports the types at the top of
// this module, so a re-served mirror's browser still sees honest link health.

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

/** Snapshot-then-delta `Stream<>` shape — the bulk-friendly counterpart
 *  to the per-key `processes` collection. With 600+ PIDs, the
 *  collection's N+1 subscribes drip a row per round-trip over a
 *  high-latency `ssh` link; this stream yields the entire keyed map
 *  in one frame (snapshot) then per-tick delta sets. The UI consumes
 *  this for the htop table; the per-key `processes` collection stays
 *  on the surface for "watch one specific PID" use cases.
 *
 *  Exported so the browser-side consumer's hermetic test can stand up a
 *  minimal surface carrying this exact wire schema (see
 *  `app/src/client/processesStream.test.ts`). */
export const ProcessesSnapshotMessage = z.discriminatedUnion("kind", [
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
    // Read-only over the wire (`verbs: ["get"]`) — the parent owns this
    // cell and writes it server-side off `session.onState` via
    // `pipeSessionStateToCell`; a remote RPC client can no longer forge
    // the host's health. The shared descriptor carries its own schema and
    // gate-closed default (kolu #1568).
    connection: connectionCell,
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
      // Signal a process on the monitored host. The agent owns the pids, so the
      // handler lives there; the parent forwards the browser's call through the
      // mirror's procedure stub (kolu #1505 R7). `signal` is the bare name; the
      // agent maps it to `SIG<name>`. Returns `{ ok }`, with `error` carrying the
      // reason on failure (ESRCH gone / EPERM not permitted) — surfaced to the
      // user, never silently swallowed.
      kill: {
        input: z.object({
          pid: PidSchema,
          signal: z.enum(["TERM", "KILL", "HUP", "INT"]).default("TERM"),
        }),
        output: z.object({ ok: z.boolean(), error: z.string().optional() }),
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
// `ConnectionInfo` / `ConnectionState` / `FailureCause` are re-exported at the
// top of this module from `@kolu/surface-nix-host/connection` (kolu #1568) —
// the shared cell is the single source of truth, so they are no longer derived
// from the local surface spec here.
export type ProcessesSnapshotMsg = SF["streams"]["processesSnapshot"]["Output"];
export type MetricSample = z.infer<typeof MetricSampleSchema>;
export type MetricHistoryMsg = SF["streams"]["metricHistory"]["Output"];
