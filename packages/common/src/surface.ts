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
import { Effect, Schema } from "effect";
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

// ⚠ **#17 mapping LAW for every schema in this file.** These shapes are the
// WIRE (agent → parent → browser) and, for `MetricSampleSchema`, the DISK ring.
// zod `.optional()` → `Schema.optionalKey` (never `Schema.optional`, which
// round-trips an explicit `undefined` through `null`); zod `.default(v)` →
// `Schema.withDecodingDefaultKey` (never `withDecodingDefault`);
// `z.discriminatedUnion("kind", …)` → `Schema.Union`, NEVER
// `Schema.TaggedUnion` (which would rename the discriminant to `_tag` and
// change the bytes).
const PidSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ProcessFacetSchema = Schema.Literals([
  "proc",
  "ports",
  "mem",
  "start_time",
  "cpu_time",
  "uid",
  "cwd",
  "status",
  "status_threads",
  "argv",
]);
const ProcessSchema = Schema.Struct({
  /** Short process name from osfacts' versioned `P` row. */
  name: Schema.String,
  /** Full argv joined for display/search and capped at the historic 200 chars. */
  command: Schema.String,
  /** Per-process CPU use. Native rows are the poll-window rate derived from
   *  osfacts cumulative counters. Command-recovered rows (see `fallbacks`)
   *  carry the producer command's own measurement (e.g. Darwin `ps` `%cpu`). */
  cpuPct: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Effective uid rendered with the historic Linux policy: uid 0 is root,
   *  every other uid is decimal. Empty only when the uid facet is unreadable. */
  user: Schema.String,
  /** Working directory from the independent cwd facet. */
  cwd: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String.check(Schema.isLengthBetween(1, 1))),
  nice: Schema.NullOr(Schema.Int),
  /** Darwin does not expose a thread count through this facet. */
  threads: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Parent process id from the same osfacts snapshot. 0 for a root/orphan,
   *  and for a pid represented only by a `U` row (no readable `P` row). */
  ppid: PidSchema,
  /** Resident set size reported by osfacts' `M` facet. Null when that facet
   *  is explicitly unreadable for this pid. */
  rssBytes: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  /** Process start identity as epoch milliseconds, derived from osfacts' `S`
   *  microsecond timestamp. Null when that facet is explicitly unreadable. */
  startedAtMs: Schema.NullOr(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  /** Listening TCP sockets attributed to this pid in the same snapshot.
   *  Address remains network-order hex: classification is consumer policy. */
  listeners: Schema.Array(
    Schema.Struct({
      port: Schema.Int.check(
        Schema.isGreaterThan(0),
        Schema.isLessThanOrEqualTo(65535),
      ),
      address: Schema.String,
      /** Socket-owner uid from osfacts' `L` row when the platform can report
       *  it. This qualifies the listener, not the process's credentials. */
      uid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  /** Values recovered through an external command after their authoritative
   *  osfacts facets were unreadable. Kept per-facet so consumers can disclose
   *  provenance without knowing which fallback commands exist. */
  fallbacks: Schema.Array(
    Schema.Struct({
      facet: ProcessFacetSchema,
      command: Schema.String.check(Schema.isMinLength(1)),
    }),
  ),
  /** Facet-specific mandatory osfacts `U` rows. A blind `ports` facet no
   *  longer makes the host listener table empty: OSF6 emits those listeners
   *  separately as claimed or unclaimed facts. */
  unreadable: Schema.Array(
    Schema.Struct({
      facet: ProcessFacetSchema,
      errno: Schema.String,
    }),
  ),
});

const UnclaimedListenerSchema = Schema.Struct({
  port: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(65535),
  ),
  address: Schema.String,
  /** Linux can identify the socket owner without identifying a pid. Darwin
   *  legitimately leaves this null. */
  uid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const SourceErrorFactSchema = Schema.Struct({
  operation: Schema.Literals(["snapshot", "host"]),
  source: Schema.String,
  facet: Schema.Literals([
    "proc",
    "ports",
    "ports_unclaimed",
    "ports_uid",
    "mem",
    "start_time",
    "cpu_time",
    "uid",
    "cwd",
    "status",
    "argv",
    "uptime",
    "load",
    "cpu",
    "net",
    "disk",
  ]),
  code: Schema.String,
});

/** The process fields whose change re-publishes a row — the `processes`
 *  collection's per-key value `equals` gate (was the agent's `processChanged`,
 *  now declared once on the spec so the `derived.collection` reconciler dedups by
 *  it instead of the write site hand-holding it). Listener arrays are rebuilt
 *  from every snapshot, so compare their contents rather than references. */
type ProcessValue = typeof ProcessSchema.Type;
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
  a.fallbacks.length === b.fallbacks.length &&
  a.fallbacks.every(
    (fact, i) =>
      fact.facet === b.fallbacks[i]?.facet &&
      fact.command === b.fallbacks[i]?.command,
  ) &&
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

const CpuCoreSchema = Schema.Struct({
  /** Busy-percentage since the previous poll tick (0-100). */
  usagePct: Schema.Number,
  /** Reported clock speed in MHz; honestly absent on Apple Silicon. */
  speedMHz: Schema.NullOr(Schema.Number.check(Schema.isGreaterThan(0))),
  model: Schema.String,
});

/** Per-network-interface I/O. Keyed by NIC name (`eth0`, `en0`, …) in the
 *  `networkInterfaces` collection. Both a level (cumulative bytes since
 *  boot) and a rate (bytes/sec over the last poll window) — throughput is
 *  the headline number; the cumulative totals are the "how much has this
 *  link carried" context. Loopback is filtered out at the agent: it's
 *  intra-host traffic, not network I/O, and would otherwise dominate the
 *  list with constant noise. */
const NetInterfaceSchema = Schema.Struct({
  /** Cumulative bytes received since boot. */
  rxBytes: Schema.Number,
  /** Cumulative bytes transmitted since boot. */
  txBytes: Schema.Number,
  /** Receive throughput in bytes/sec over the last poll window. 0 on the
   *  first tick (no previous counters to delta against yet). */
  rxRate: Schema.Number,
  /** Transmit throughput in bytes/sec over the last poll window. */
  txRate: Schema.Number,
});
const SystemSchema = Schema.Struct({
  /** 1-minute, 5-minute, 15-minute load averages. */
  loadAvg: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
  /** Mean busy-percentage across every core (0-100) — the single host-CPU
   *  aggregate, computed ONCE at the agent (which already reads per-core usage
   *  each tick) and carried on this fixed-cardinality cell. A glance card reads
   *  this scalar instead of subscribing to the per-key `cpuCores` collection and
   *  averaging all N cores client-side — a `.map(byKey)` reduction silently opens
   *  N per-core value streams per host, the fleet's O(hosts×cores) CPU sink. The
   *  per-core `cpuCores` collection stays for the host drill-in that renders a
   *  bar per core. */
  cpuPct: Schema.Number,
  /** Number of cores the agent observed — lets a glance card show "N cores"
   *  without touching the per-key `cpuCores` collection just for its key count. */
  coreCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Bytes used / total — UI converts to GB. */
  memUsed: Schema.Number,
  memTotal: Schema.Number,
  /** Swap bytes used / total from osfacts V2. Both are 0 on a host with swap
   *  disabled; `swapPct` guards the divide. */
  swapUsed: Schema.Number,
  swapTotal: Schema.Number,
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
  diskUsed: Schema.Number,
  diskTotal: Schema.Number,
  /** Seconds since boot. */
  uptime: Schema.Number,
  /** OS family observed through osfacts. */
  os: Schema.Literals(["linux", "darwin", "unknown"]),
  /** Resolved hostname inside the agent (parent shows this in the
   *  header chip — useful when the parent ssh'd by an alias). */
  hostname: Schema.String,
  /** Agent's poll cadence in milliseconds — the UI displays this so
   *  the cadence is single-sourced at the agent (which actually owns
   *  the setInterval). */
  pollIntervalMs: Schema.Number,
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

export const DEFAULT_SYSTEM: typeof SystemSchema.Type = {
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

/** Agent surface contract version — control-core hello `surfaceVersion` and
 *  parent convergence policy `baked.contractVersion`. Single source for agent
 *  main, parent hostRegistry, and mixed-build / policy tests. */
export const AGENT_SURFACE_VERSION = "1.0";

/** One point in a host's metric history — CPU% and memory% at a wall-clock
 *  instant. Captured by the **agent daemon** on each poll tick and retained
 *  in a durable on-disk ring (`history.ring.json` under the daemon home) so
 *  the ring survives parent deploys and reconnects. */
export const MetricSampleSchema = Schema.Struct({
  /** Wall-clock capture time, epoch ms. */
  t: Schema.Number,
  /** Mean busy-percentage across all cores at capture (0-100). */
  cpu: Schema.Number,
  /** Memory used as a percentage of total at capture (0-100). */
  mem: Schema.Number,
  /** Swap used as a percentage of total at capture (0-100). */
  swap: Schema.Number,
  /** Root-filesystem used as a percentage of total at capture (0-100). */
  disk: Schema.Number,
});

/** Typed reasons a metric-history ring cannot be served. Single source for
 *  the wire schema, HistoryView, and historyRing load dispositions. */
export const MetricHistoryUnavailableReasons = [
  "unknown-version",
  "corrupt",
  /** Bytes never judged (EACCES/EIO/…); file left in place — do not overwrite. */
  "unreadable",
] as const;
export type MetricHistoryUnavailableReason =
  (typeof MetricHistoryUnavailableReasons)[number];

/** Snapshot-then-delta `Stream<>` for the per-host metric-history ring.
 *  A new subscriber gets the agent daemon's entire ring in one `snapshot`
 *  frame, then one `delta` per poll tick. The ring lives in the agent
 *  daemon (survives parent deploys); the parent re-serves it to browsers.
 *
 *  `unavailable` is a TYPED standing disposition — never a silently empty
 *  chart. `degraded` means samples still serve but durability was lost.
 *
 *  `Schema.Union`, **not** `Schema.TaggedUnion`: the discriminant is `kind`,
 *  and a tagged union would rename it to `_tag` — these bytes are frozen (they
 *  cross the agent→parent→browser hop AND the daemon-restart boundary). */
export const MetricHistoryMessage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    samples: Schema.Array(MetricSampleSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("delta"),
    sample: MetricSampleSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals(MetricHistoryUnavailableReasons),
  }),
  Schema.Struct({
    kind: Schema.Literal("degraded"),
    reason: Schema.Literal("persist-failed"),
    samples: Schema.Array(MetricSampleSchema),
  }),
]);

/** `process.kill`'s argument — the two #17 landmines of this repo, both here.
 *
 *  `signal` absent on the wire ⇒ decoded as `"TERM"`.
 *  `Schema.withDecodingDefaultKey`, never `withDecodingDefault`: the key may be
 *  MISSING, never an explicit `undefined` (which the latter round-trips through
 *  `null`, changing the bytes for every caller that spells the key). */
const KillInputSchema = Schema.Struct({
  pid: PidSchema,
  signal: Schema.Literals(["TERM", "KILL", "HUP", "INT"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("TERM" as const)),
  ),
});
/** `error` is `Schema.optionalKey`, never `Schema.optional`: a successful kill
 *  OMITS the key rather than sending `"error":null`, exactly as zod's
 *  `.optional()` did. */
const KillOutputSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});

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
      keySchema: Schema.String,
      schema: UnclaimedListenerSchema,
      verbs: ["keys", "get", "deltas"],
    },
    /** Named `E` rows accompanying an otherwise usable partial osfacts frame. */
    sourceErrors: {
      keySchema: Schema.String,
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
      keySchema: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
      keySchema: Schema.String,
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
      kill: { input: KillInputSchema, output: KillOutputSchema },
    },
  },
  streams: {
    /** Durable metric-history ring — owned by the agent daemon, re-served by
     *  the parent. Snapshot-then-delta (or a typed `unavailable` disposition
     *  when the on-disk ring is corrupt / unknown-version). */
    metricHistory: {
      inputSchema: Schema.Struct({}),
      outputSchema: MetricHistoryMessage,
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
export type MetricSample = typeof MetricSampleSchema.Type;
export type MetricHistoryMsg = typeof MetricHistoryMessage.Type;
/** `process.kill`'s argument as a CALLER spells it — the ENCODED side, where
 *  `signal` is optional — and its result on the DECODED side. `SurfaceTypes`
 *  covers the four reactive primitives; a procedure's two sides are read off
 *  its own schemas (#13: an input is a pure argument, so it is Encoded). */
export type KillArgs = typeof KillInputSchema.Encoded;
export type KillResult = typeof KillOutputSchema.Type;
// Stream message type is also available off the surface's typed streams map
// once metricHistory is a first-class surface member (UW3 — agent owns the ring).
