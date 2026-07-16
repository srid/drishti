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
import { z } from "zod";
import { alertsEqual, AlertsSchema, NO_ALERTS } from "./alerts";

// IMPORTANT: this module is AGENT-shared (drishti-common's `.` export — the
// agent serves the base surface from it). It must NOT import
// `@kolu/surface-remote`: the agent's scoped build hydrates only `@kolu/surface`,
// so a runtime import of the parent-only provisioning lib crashes the agent at
// load. The connection-cell types, `DEFAULT_CONNECTION`, and the `browserSurface`
// mirror-seam composition therefore live in the APP-only `drishti-common/browser`
// subpath (./browser.ts), imported only by the parent re-serve + the client.

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
   *  (EACCES on `/proc/<pid>/cwd` on linux; no `lsof` cwd line on darwin).
   *  On darwin the value is the LAST-LANDED enrichment run's observation
   *  (the lsof child is never awaited by the poll — see createCwdEnricher in
   *  the agent package, packages/agent/src/proc.ts), so it fills one poll
   *  tick late and may be stale on a host whose lsof is slow. Dead pids are
   *  pruned only once a poll tick observes them ABSENT, so the common
   *  die-then-observed-dead-then-recycled case blanks within one tick — but a
   *  pid recycled within a single poll window (never observed dead) can
   *  inherit the previous process's cwd until the next landed enrichment run,
   *  bounded by the enrichment backoff ceiling (minutes, not one tick). */
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

/** The process fields whose change re-publishes a row — the `processes`
 *  collection's per-key value `equals` gate (was the agent's `processChanged`,
 *  now declared once on the spec so the `derived.collection` reconciler dedups by
 *  it instead of the write site hand-holding it). `startedAtMs` is immutable per
 *  pid, so it is deliberately absent; `satisfies` ties each entry to a real schema
 *  field so a typo or renamed field fails to compile. */
const MUTABLE_PROCESS_FIELDS = [
  "user",
  "cpuPct",
  "rssBytes",
  "command",
  "cwd",
  "ppid",
  "state",
  "nice",
  "threads",
] as const satisfies readonly (keyof z.infer<typeof ProcessSchema>)[];

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
  /** Mean busy-percentage across every core (0-100) — the single host-CPU
   *  aggregate, computed ONCE at the agent (which already reads per-core usage
   *  each tick) and carried on this fixed-cardinality cell. A glance card reads
   *  this scalar instead of subscribing to the per-key `cpuCores` collection and
   *  averaging all N cores client-side — a `.map(byKey)` reduction silently opens
   *  N per-core value streams per host, the fleet's O(hosts×cores) CPU sink. The
   *  per-core `cpuCores` collection stays for the host drill-in that renders a
   *  bar per core. */
  cpuPct: z.number(),
  /** Number of cores the agent observed — lets a glance card show "N cores"
   *  without touching the per-key `cpuCores` collection just for its key count. */
  coreCount: z.number().int().nonnegative(),
  /** Bytes used / total — UI converts to GB. */
  memUsed: z.number(),
  memTotal: z.number(),
  /** Swap bytes used / total. `swapUsed = SwapTotal − SwapFree` on linux
   *  (`/proc/meminfo`); `total`/`used` from `sysctl vm.swapusage` on darwin.
   *  Both 0 on a host with swap disabled (no swap device, or an unknown
   *  platform) — `swapPct` guards the divide, so it reads as 0% rather than
   *  NaN, the same "unavailable → 0" convention memory and disk use. */
  swapUsed: z.number(),
  swapTotal: z.number(),
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
// `@kolu/surface-remote/connection`. It is byte-identical in shape to
// drishti's former local `ConnectionSchema` (the five link phases, nullable
// `lastError`, nullable `network|remote` `failureCause`, `progressLines` tail).
// drishti adds it ONLY at the re-serve seam via `mirroredSurface` (`browserSurface`)
// and re-exports the types at the top of this module, so a re-served mirror's
// browser sees honest link health while the base surface stays connection-free.

export const DEFAULT_SYSTEM: z.infer<typeof SystemSchema> = {
  loadAvg: [0, 0, 0],
  cpuPct: 0,
  coreCount: 0,
  memUsed: 0,
  memTotal: 0,
  swapUsed: 0,
  swapTotal: 0,
  diskUsed: 0,
  diskTotal: 0,
  uptime: 0,
  os: "unknown",
  hostname: "",
  pollIntervalMs: 0,
};

// The bulk snapshot-then-delta wire schema for the whole process set is now the
// framework's own — the `processes` collection declares the `deltas` verb (above),
// so `@kolu/surface` serves ONE coalesced snapshot-then-delta stream for it (SR5).
// The hand-rolled `ProcessesSnapshotMessage` parallel stream is gone.

/** One point in a host's metric history — CPU% and memory% at a wall-clock
 *  instant. Captured by the **parent** on each agent poll tick (the parent
 *  is the only tier that observes every tick regardless of which browser
 *  tabs are open) and retained in an in-memory ring for the life of the
 *  parent process. */
export const MetricSampleSchema = z.object({
  /** Wall-clock capture time, epoch ms. */
  t: z.number(),
  /** Mean busy-percentage across all cores at capture (0-100). */
  cpu: z.number(),
  /** Memory used as a percentage of total at capture (0-100). */
  mem: z.number(),
  /** Swap used as a percentage of total at capture (0-100). */
  swap: z.number(),
  /** Root-filesystem used as a percentage of total at capture (0-100). */
  disk: z.number(),
});

/** Snapshot-then-delta `Stream<>` for the per-host metric-history ring —
 *  the same bulk-friendly shape as `processesSnapshot`. A new subscriber
 *  (a freshly-loaded browser, or a tab just switched to this host) gets the
 *  parent's entire ring in one `snapshot` frame, then one `delta` per poll
 *  tick. This is why history survives reloads and tab switches: the state
 *  lives in the parent, and every subscriber is re-seeded from it. */
export const MetricHistoryMessage = z.discriminatedUnion("kind", [
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
    // Per-host raised-alert set — a threshold+hysteresis fold over the host's
    // metrics (see `./alerts.ts`). Wire-READ-ONLY (`verbs: ["get"]`): the agent
    // is the sole writer via `@kolu/surface/reactor`'s `derived.cell(scan(...))`,
    // so the boot walk MUST see get-only here or it crashes on a write verb.
    // `equals: alertsEqual` is the final wire dedup — a metric drifting within
    // an already-raised level publishes nothing (same id set). This stays
    // reactor-FREE: only schema/default/verbs/equals, no graph import (the
    // reactor lives in the AGENT's main.ts, never in this agent-shared module).
    alerts: {
      schema: AlertsSchema,
      default: NO_ALERTS,
      verbs: ["get"],
      equals: alertsEqual,
    },
    // NOTE: no `connection` cell here. Link health is composed ONLY at the
    // nix-host re-serve seam via `mirroredSurface(surface)` (`browserSurface`
    // below) — the agent serves this connection-free base; the parent mirrors
    // it and adds the cell, writing it off `session.onState` (kolu #1568).
  },
  collections: {
    /** Per-process facts — keyed by pid. The host view renders the whole htop
     *  table (every process ticks every poll), so it opts into batched `deltas`:
     *  the agent serves one coalesced snapshot-then-delta stream for the whole
     *  collection instead of a `keys`+per-key-`get` fan-out, and the parent mirrors
     *  it through the framework's one wire protocol (SR5 — one protocol across the
     *  wire). The per-key `get` path stays for "watch one specific pid". */
    processes: {
      keySchema: PidSchema,
      schema: ProcessSchema,
      // WIRE-READ-ONLY: the agent serves this as a `derived.collection` (the poll
      // reconciler is the one writer), so no `upsert`/`delete` wire verbs. `equals`
      // is the reconciler's per-key diff — republish a row only when a mutable field
      // moved (the old agent-side `processChanged`, declared once here).
      verbs: ["keys", "get", "deltas"],
      equals: (a, b) => MUTABLE_PROCESS_FIELDS.every((f) => a[f] === b[f]),
    },
    /** Per-core CPU usage — small-N (typical 4-32) `Collection<K,T>`.
     *  The host drill-in renders one bar per core, so per-key reactive identity
     *  is the right shape. But every core ticks every poll, so the host view
     *  reads the WHOLE collection — hence the opt-in `deltas` verb: the parent
     *  re-serves all N cores in one coalesced frame per tick instead of one
     *  per-key frame each (the per-key `get` path stays for "watch one core").
     *  The fleet card reads the `system.cpuPct` aggregate and never subscribes
     *  here at all. */
    cpuCores: {
      keySchema: z.number().int().nonnegative(),
      schema: CpuCoreSchema,
      // WIRE-READ-ONLY `derived.collection`. No `equals`: usage is a per-tick rate
      // that always moves, so the reconciler republishes every present key each
      // frame (the unconditional upsert the poll loop did).
      verbs: ["keys", "get", "deltas"],
    },
    /** Per-NIC network I/O — keyed by interface name, the same `Collection<K,T>`
     *  shape as `cpuCores`. The host view reads the whole set (dozens of NICs,
     *  most idle), so it opts into batched `deltas` too — dozens of per-key
     *  frames per tick collapse to one. */
    networkInterfaces: {
      keySchema: z.string(),
      schema: NetInterfaceSchema,
      // WIRE-READ-ONLY `derived.collection`; no `equals` — throughput shifts almost
      // every tick, so unconditional per-key republish (as the poll loop did).
      verbs: ["keys", "get", "deltas"],
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
// `ConnectionInfo` / `ConnectionState` / `FailureCause` are re-exported from the
// app-only `drishti-common/browser` subpath (./browser.ts), NOT here — see the
// agent-safety note near the top of this file.
export type MetricSample = z.infer<typeof MetricSampleSchema>;
// `metricHistory` is a PARENT-LOCAL member now (composed onto the mirrored agent
// surface via `extendSurface`), so its message type comes from the schema, not the
// shared `SF` surface it left.
export type MetricHistoryMsg = z.infer<typeof MetricHistoryMessage>;
