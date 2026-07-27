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

/** Present osfacts' network-order listener bytes at the consumer edge.
 *
 * The wire deliberately stays raw and versioned. This formatter owns the one
 * UI policy: dotted IPv4, RFC 5952-compressed/bracketed IPv6, and plain dotted
 * IPv4 for v4-mapped v6 addresses. Unknown input is left visible rather than
 * throwing during rendering. */
export function formatListenerAddress(address: string, port: number): string {
  if (/^[0-9a-f]{8}$/i.test(address)) {
    const octets = address.match(/../g)?.map((byte) => Number.parseInt(byte, 16));
    return `${octets?.join(".") ?? address}:${port}`;
  }
  if (!/^[0-9a-f]{32}$/i.test(address)) return `${address}:${port}`;

  const bytes = address.match(/../g)?.map((byte) => Number.parseInt(byte, 16));
  if (bytes === undefined) return `${address}:${port}`;
  const isV4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (isV4Mapped) return `${bytes.slice(12).join(".")}:${port}`;

  const groups = Array.from(
    { length: 8 },
    (_, i) => ((bytes[i * 2] ?? 0) << 8) | (bytes[i * 2 + 1] ?? 0),
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length; ) {
    if (groups[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < groups.length && groups[end] === 0) end++;
    const length = end - start;
    if (length > bestLength && length >= 2) {
      bestStart = start;
      bestLength = length;
    }
    start = end;
  }
  const rendered = groups.map((group) => group.toString(16));
  const ipv6 =
    bestStart < 0
      ? rendered.join(":")
      : `${rendered.slice(0, bestStart).join(":")}::${rendered
          .slice(bestStart + bestLength)
          .join(":")}`;
  return `[${ipv6}]:${port}`;
}

// IMPORTANT: this module is AGENT-shared (drishti-common's `.` export — the
// agent serves the base surface from it). It must NOT import
// `@kolu/surface-remote`: the agent's scoped build hydrates only `@kolu/surface`,
// so a runtime import of the parent-only provisioning lib crashes the agent at
// load. The connection-cell types, `DEFAULT_CONNECTION`, and the `browserSurface`
// mirror-seam composition therefore live in the APP-only `drishti-common/browser`
// subpath (./browser.ts), imported only by the parent re-serve + the client.

const PidSchema = z.number().int().nonnegative();
const ProcessSchema = z.object({
  /** Short process name from osfacts' versioned `P` row. */
  name: z.string(),
  /** Full argv joined for display/search and capped at the historic 200 chars. */
  command: z.string(),
  /** Per-process CPU use over the last poll window. osfacts publishes a
   *  cumulative counter; the agent derives this consumer-side rate. */
  cpuPct: z.number().nonnegative(),
  /** Effective uid rendered with the historic Linux policy: uid 0 is root,
   *  every other uid is decimal. Empty only when the uid facet is unreadable. */
  user: z.string(),
  /** Working directory from the independent cwd facet. */
  cwd: z.string().nullable(),
  state: z.string().length(1).nullable(),
  nice: z.number().int().nullable(),
  /** Darwin does not expose a thread count through this facet. */
  threads: z.number().int().positive().nullable(),
  /** Parent process id from the same osfacts snapshot. 0 for a root/orphan,
   *  and for a pid represented only by a `U` row (no readable `P` row). */
  ppid: PidSchema,
  /** Resident set size reported by osfacts' `M` facet. Null when that facet
   *  is explicitly unreadable for this pid. */
  rssBytes: z.number().int().nonnegative().nullable(),
  /** Process start identity as epoch milliseconds, derived from osfacts' `S`
   *  microsecond timestamp. Null when that facet is explicitly unreadable. */
  startedAtMs: z.number().nonnegative().nullable(),
  /** Listening TCP sockets attributed to this pid in the same snapshot.
   *  Address remains network-order hex: classification is consumer policy. */
  listeners: z.array(
    z.object({
      port: z.number().int().positive().max(65535),
      address: z.string(),
      /** Socket-owner uid from osfacts' `L` row when the platform can report
       *  it. This qualifies the listener, not the process's credentials. */
      uid: z.number().int().nonnegative().nullable(),
    }),
  ),
  /** Facet-specific mandatory osfacts `U` rows. A blind `ports` facet no
   *  longer makes the host listener table empty: OSF6 emits those listeners
   *  separately as claimed or unclaimed facts. */
  unreadable: z.array(
    z.object({
      facet: z.enum([
        "proc",
        "ports",
        "mem",
        "start_time",
        "cpu_time",
        "uid",
        "cwd",
        "status",
        "argv",
      ]),
      errno: z.string(),
    }),
  ),
});

const UnclaimedListenerSchema = z.object({
  port: z.number().int().positive().max(65535),
  address: z.string(),
  /** Linux can identify the socket owner without identifying a pid. Darwin
   *  legitimately leaves this null. */
  uid: z.number().int().nonnegative().nullable(),
});

const SourceErrorFactSchema = z.object({
  operation: z.enum(["snapshot", "host"]),
  source: z.string(),
  code: z.string(),
});

/** The process fields whose change re-publishes a row — the `processes`
 *  collection's per-key value `equals` gate (was the agent's `processChanged`,
 *  now declared once on the spec so the `derived.collection` reconciler dedups by
 *  it instead of the write site hand-holding it). Listener arrays are rebuilt
 *  from every snapshot, so compare their contents rather than references. */
type ProcessValue = z.infer<typeof ProcessSchema>;
const processEqual = (a: ProcessValue, b: ProcessValue): boolean =>
  a.name === b.name &&
  a.command === b.command &&
  a.cpuPct === b.cpuPct &&
  a.user === b.user &&
  a.cwd === b.cwd &&
  a.state === b.state &&
  a.nice === b.nice &&
  a.threads === b.threads &&
  a.ppid === b.ppid &&
  a.rssBytes === b.rssBytes &&
  a.startedAtMs === b.startedAtMs &&
  a.unreadable.length === b.unreadable.length &&
  a.unreadable.every(
    (fact, i) =>
      fact.facet === b.unreadable[i]?.facet &&
      fact.errno === b.unreadable[i]?.errno,
  ) &&
  a.listeners.length === b.listeners.length &&
  a.listeners.every(
    (listener, i) =>
      listener.port === b.listeners[i]?.port &&
      listener.address === b.listeners[i]?.address &&
      listener.uid === b.listeners[i]?.uid,
  );

const CpuCoreSchema = z.object({
  /** Busy-percentage since the previous poll tick (0-100). */
  usagePct: z.number(),
  /** Reported clock speed in MHz; honestly absent on Apple Silicon. */
  speedMHz: z.number().positive().nullable(),
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
  /** Swap bytes used / total from osfacts V2. Both are 0 on a host with swap
   *  disabled; `swapPct` guards the divide. */
  swapUsed: z.number(),
  swapTotal: z.number(),
  /** Bytes used / total on the **root filesystem** (`/`) from osfacts V2.
   *  `diskUsed = total − free`: occupied blocks, matching the native reader's
   *  historic meaning (reserved blocks count as occupied, not user-available).
   *
   *  ⚠ **Mount-selection policy: root `/` only.** Unlike memory (one
   *  authoritative host figure), a host has many filesystems and no single
   *  capacity aggregate; this scalar deliberately reports just `/`. A host
   *  that splits `/var`, `/nix`, or `/data` onto separate disks will not see
   *  those here — a per-mount view is a future `diskDevices` collection
   *  (mirroring `networkInterfaces`), not a reinterpretation of this field.
   *  `pctOf` guards the divide. */
  diskUsed: z.number(),
  diskTotal: z.number(),
  /** Seconds since boot. */
  uptime: z.number(),
  /** OS family observed through osfacts. */
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
      equals: processEqual,
    },
    /** Host listeners whose socket fact is readable but whose owning pid is
     *  not attributable. This is the OSF6 distinction that lets drishti show
     *  a complete listener table without pretending permission-blind sockets
     *  do not exist. */
    unclaimedListeners: {
      keySchema: z.string(),
      schema: UnclaimedListenerSchema,
      verbs: ["keys", "get", "deltas"],
    },
    /** Named `E` rows accompanying an otherwise usable partial osfacts frame. */
    sourceErrors: {
      keySchema: z.string(),
      schema: SourceErrorFactSchema,
      verbs: ["keys", "get", "deltas"],
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
export type UnclaimedListenerId = SF["collections"]["unclaimedListeners"]["Key"];
export type UnclaimedListener = SF["collections"]["unclaimedListeners"]["Value"];
export type SourceErrorFact = SF["collections"]["sourceErrors"]["Value"];
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
