/**
 * Cross-platform process + system info readers.
 *
 * Process/socket inspection is one path on both supported platforms:
 * `osfacts-client` over the Nix-baked osfacts binary. System and network
 * telemetry remain platform-specific (`/proc` on linux, vm_stat/sysctl/
 * netstat on darwin) because they are outside osfacts' process contract.
 *
 * Universality is the point. The plan considered tailing logs and cut it
 * — no plain-text log file is universally readable, universally present,
 * and actively updating across darwin/linux in 2025. Process metrics
 * are.
 */

import { execFile as execFileCb } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import {
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  totalmem,
  uptime,
} from "node:os";
import { promisify } from "node:util";
import {
  type OsfactsReading,
  snapshotSubtree,
} from "osfacts-client";
import type {
  CoreId,
  CpuCore,
  IfaceName,
  NetInterface,
  Pid,
  Process,
  SystemInfo,
} from "drishti-common";

// execFile, NOT exec: exec launches `/bin/sh -c '<cmd>'`, and the kill budget
// then times/signals the intermediary SHELL — whether the actual utility dies
// with it depends on the shell's exec-last-command optimization, which is an
// implementation detail, not a guarantee. execFile spawns the utility
// directly, so the budget's SIGKILL provably targets it. None of the darwin
// children need shell features (no pipes, globs, or quoting).
const execFile = promisify(execFileCb);

/** Hardware/OS observations only. `pollIntervalMs` is owned by the agent's run
 *  loop, and the CPU aggregate (`cpuPct`/`coreCount`) is folded in from
 *  `readCpuCores` — both spliced onto the `system` cell at publish time, so the
 *  raw read produces neither. */
type RawSystemInfo = Omit<
  SystemInfo,
  "pollIntervalMs" | "cpuPct" | "coreCount"
>;

export interface ProcReader {
  os: SystemInfo["os"];
  readSystem: () => Promise<RawSystemInfo>;
  readProcesses: () => Promise<Map<Pid, Process>>;
  /** Per-core busy% since the last call. The first call seeds the
   *  baseline and returns 0% across the board (no delta to measure
   *  yet). Universally available via `node:os.cpus()` — same shape on
   *  linux and darwin. */
  readCpuCores: () => Map<CoreId, CpuCore>;
  /** Per-NIC cumulative bytes + throughput. Like `readCpuCores`, the
   *  rate is a delta against the previous call — the first call seeds the
   *  baseline and reports 0 bytes/sec. Async because the source is a file
   *  read (linux) or a subprocess (darwin). Empty on unknown platforms. */
  readNetwork: () => Promise<Map<IfaceName, NetInterface>>;
}

/** Closure that retains the previous `cpus()` snapshot for delta-busy
 *  computation. Per-core CPU usage is a *rate*, not a level — needs
 *  the previous tick's timing to compute. */
function createCpuCoresReader(): () => Map<CoreId, CpuCore> {
  let prev = cpus();
  return () => {
    const cur = cpus();
    const result = new Map<CoreId, CpuCore>();
    for (let i = 0; i < cur.length; i++) {
      const c = cur[i];
      const p = prev[i];
      if (c === undefined || p === undefined) continue;
      const idleDelta = c.times.idle - p.times.idle;
      const totalDelta =
        c.times.user +
        c.times.nice +
        c.times.sys +
        c.times.idle +
        c.times.irq -
        (p.times.user +
          p.times.nice +
          p.times.sys +
          p.times.idle +
          p.times.irq);
      const usagePct = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;
      result.set(i, {
        usagePct: Math.round(usagePct * 10) / 10,
        speedMHz: c.speed,
        model: c.model.trim(),
      });
    }
    prev = cur;
    return result;
  };
}

// ── Network I/O reading ─────────────────────────────────────────────────

/** Cumulative byte counters for one interface — the raw observation a
 *  platform parser yields, before throughput is derived. */
export interface NetCounters {
  rxBytes: number;
  txBytes: number;
}

/** Loopback carries intra-host traffic, not network I/O, and is always
 *  busy — every comparable monitor (rtop, htop, glances) hides it. Filter
 *  it in the reader (not the parser) so the parsers stay faithful to their
 *  source. `lo` on linux, `lo0` on darwin. */
function isLoopback(name: string): boolean {
  return name === "lo" || name === "lo0";
}

/** Parse `/proc/net/dev`. Each data line is `name: rx_bytes rx_packets …
 *  (8 receive fields) tx_bytes tx_packets …` — so receive bytes are the
 *  first number after the colon and transmit bytes the ninth. The two
 *  header lines have no colon and are skipped. Split on the first colon:
 *  modern interface names (`eth0`, `enp3s0`, `wlan0`, `eth0.100`) contain
 *  no colon; deprecated `eth0:0` IP aliases are the rare exception and
 *  would mis-split, but those no longer appear as separate `/proc/net/dev`
 *  rows on current kernels. */
export function parseProcNetDev(content: string): Map<string, NetCounters> {
  const out = new Map<string, NetCounters>();
  for (const line of content.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name.length === 0) continue;
    const nums = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    const rxBytes = nums[0];
    const txBytes = nums[8];
    if (rxBytes === undefined || txBytes === undefined) continue;
    if (Number.isNaN(rxBytes) || Number.isNaN(txBytes)) continue;
    out.set(name, { rxBytes, txBytes });
  }
  return out;
}

/** Parse `netstat -ib` (darwin). Each interface has several rows (one per
 *  address family); the `<Link#N>` row is the link-layer aggregate — the
 *  one whose byte counters cover the whole interface — so we read only
 *  those. The optional Address (MAC) column shifts the absolute field
 *  positions, so count from the right, where the layout is stable:
 *  `… Ibytes Opkts Oerrs Obytes Coll` → Ibytes is 5th-from-last, Obytes
 *  is 2nd-from-last. */
export function parseNetstatIb(content: string): Map<string, NetCounters> {
  const out = new Map<string, NetCounters>();
  for (const line of content.split("\n")) {
    if (!line.includes("<Link#")) continue;
    const cols = line.trim().split(/\s+/);
    const name = cols[0];
    const rxBytes = Number(cols[cols.length - 5]);
    const txBytes = Number(cols[cols.length - 2]);
    if (name === undefined || name.length === 0) continue;
    if (Number.isNaN(rxBytes) || Number.isNaN(txBytes)) continue;
    // First-occurrence wins — one <Link#> row per interface, but guard
    // against a malformed dump repeating a name.
    if (!out.has(name)) out.set(name, { rxBytes, txBytes });
  }
  return out;
}

/** Derive per-interface throughput from two cumulative-counter snapshots
 *  and the seconds between them. Pure — the clock lives in the caller so
 *  this stays unit-testable. `winSec <= 0` (the first tick) yields 0
 *  rates. Counters that ran backwards (counter reset, NIC hot-swap, pid
 *  recycling of the name) clamp to 0 rather than report a negative or
 *  absurd spike. */
export function computeNetThroughput(
  prev: Map<string, NetCounters>,
  cur: Map<string, NetCounters>,
  winSec: number,
): Map<IfaceName, NetInterface> {
  const out = new Map<IfaceName, NetInterface>();
  for (const [name, c] of cur) {
    const p = prev.get(name);
    let rxRate = 0;
    let txRate = 0;
    if (p && winSec > 0) {
      rxRate = Math.max(0, (c.rxBytes - p.rxBytes) / winSec);
      txRate = Math.max(0, (c.txBytes - p.txBytes) / winSec);
    }
    out.set(name, {
      rxBytes: c.rxBytes,
      txBytes: c.txBytes,
      rxRate: Math.round(rxRate),
      txRate: Math.round(txRate),
    });
  }
  return out;
}

/** Closure wrapping `computeNetThroughput` with the previous snapshot and
 *  wall clock — the same rate-from-delta shape `createCpuCoresReader`
 *  uses, but async since the raw counters come from a file read or
 *  subprocess. `readRaw` already excludes loopback. */
function createNetReader(
  readRaw: () => Promise<Map<string, NetCounters>>,
): () => Promise<Map<IfaceName, NetInterface>> {
  // The previous counters and when they were sampled are one concept —
  // they must advance together every tick. Holding them as a single record
  // (rather than two `let`s) makes the swap atomic, so a future edit can't
  // update the counters while forgetting the timestamp.
  let prev: { counters: Map<string, NetCounters>; takenMs: number } = {
    counters: new Map(),
    takenMs: 0,
  };
  return async () => {
    const counters = await readRaw();
    const takenMs = Date.now();
    const winSec = prev.takenMs > 0 ? (takenMs - prev.takenMs) / 1000 : 0;
    const out = computeNetThroughput(prev.counters, counters, winSec);
    prev = { counters, takenMs };
    return out;
  };
}

function filterLoopback(
  counters: Map<string, NetCounters>,
): Map<string, NetCounters> {
  const out = new Map<string, NetCounters>();
  for (const [name, c] of counters) {
    if (!isLoopback(name)) out.set(name, c);
  }
  return out;
}

// ── Disk usage (root filesystem) ────────────────────────────────────────

/** Used/total bytes derived from a `statfs` result — pure, so the block
 *  arithmetic is unit-testable without a real mount. `total = blocks × bsize`;
 *  `used = (blocks − bfree) × bsize` — the bytes-occupied figure, parity with
 *  memory's `total − available`, so `diskPct` reads like `memPct`. Zeros when
 *  `bsize`/`blocks` are 0. */
export function diskBytesFromStatfs(stat: {
  bsize: number;
  blocks: number;
  bfree: number;
}): { diskUsed: number; diskTotal: number } {
  return {
    diskUsed: (stat.blocks - stat.bfree) * stat.bsize,
    diskTotal: stat.blocks * stat.bsize,
  };
}

/** Root-filesystem (`/`) usage via the `statfs` syscall — the one capacity
 *  source universal across linux and darwin (no `/proc` file reports free
 *  space). Reports `/` only by deliberate policy; see the mount-selection note
 *  on `SystemSchema.diskUsed`.
 *
 *  SINGLE-FLIGHT PROBE + LAST-KNOWN VALUE, not an awaited read: statfs is a
 *  syscall with no timeout knob, and it sits under the same
 *  settlement-dependent guards as the exec children (main.ts's `singleFlight`
 *  tick) — a root filesystem in D-state (dying disk, wedged network root)
 *  would otherwise freeze the `system` cell and the alerts reactor forever,
 *  the exact wedge the child kill-budgets close. The probe-cache bounds the
 *  damage to ONE wedged libuv threadpool thread (an awaited deadline-race
 *  would stack a fresh wedged statfs every tick until the pool starves), and
 *  callers always get the last observation immediately — 0/0 ("unavailable"
 *  via `pctOf`) until the first probe lands, one tick on a healthy host.
 *  A FAILED probe keeps the last
 *  observation: statfs-unavailable platforms (e.g. Windows) fail instantly
 *  each tick, which is cheap and stays 0/0; a once-working disk that starts
 *  erroring serves its last reading rather than flapping to zeros. */
const readRootDiskUsage = (() => {
  let last = { diskUsed: 0, diskTotal: 0 };
  let probe: Promise<void> | undefined;
  return (): { diskUsed: number; diskTotal: number } => {
    if (probe === undefined) {
      probe = statfs("/").then(
        (s) => {
          last = diskBytesFromStatfs(s);
          probe = undefined;
        },
        () => {
          // Keep the last observation (see doc above) — safe to swallow: 0/0
          // renders as "unavailable", and a transiently-erroring disk holding
          // its previous reading beats a flapping gauge.
          probe = undefined;
        },
      );
    }
    return last;
  };
})();

export function createProcReader(): ProcReader {
  const plat = platform();
  if (plat === "linux") return linuxReader(osfactsBinPath());
  if (plat === "darwin") return darwinReader(execFile, osfactsBinPath());
  return stubReader();
}

/** Absolute binary path baked by the Nix wrapper/dev shell. Required by
 * design: a missing bake is a broken package, never a cue to search PATH or
 * fall back to lsof/ps/proc inspection. */
export function osfactsBinPath(): string {
  const bin = process.env.DRISHTI_OSFACTS_BIN;
  if (!bin) {
    throw new Error(
      "DRISHTI_OSFACTS_BIN is not set — run the Nix-wrapped drishti-agent (no PATH fallback)",
    );
  }
  return bin;
}

/** Join one atomic osfacts reading into drishti's keyed collection. U-only
 * pids get explicit rows, while a readable pid may also carry a U row when a
 * requested facet (notably ports) was denied. Thus `listeners: []` is only
 * observed-empty when `unreadableErrno` is null. */
export function processesFromOsfacts(
  reading: OsfactsReading,
): Map<Pid, Process> {
  const out = new Map<Pid, Process>();
  for (const row of reading.procs) {
    out.set(row.pid, {
      command: row.name,
      ppid: row.ppid,
      listeners: [],
      unreadableErrno: null,
    });
  }
  for (const listener of reading.ports) {
    const proc = out.get(listener.pid) ?? {
      command: "",
      ppid: 0,
      listeners: [],
      unreadableErrno: null,
    };
    proc.listeners.push({ port: listener.port, address: listener.address });
    out.set(listener.pid, proc);
  }
  for (const unreadable of reading.unreadable) {
    const proc = out.get(unreadable.pid) ?? {
      command: "",
      ppid: 0,
      listeners: [],
      unreadableErrno: null,
    };
    proc.unreadableErrno = unreadable.errno;
    out.set(unreadable.pid, proc);
  }
  for (const proc of out.values()) {
    proc.listeners.sort(
      (a, b) => a.port - b.port || a.address.localeCompare(b.address),
    );
  }
  return out;
}

export type SnapshotSubtree = typeof snapshotSubtree;

/** The host process tree is PID 1's subtree on linux and launchd-based
 * darwin. osfacts performs the traversal and socket attribution in one
 * versioned snapshot; drishti performs no second OS walk. */
export function createOsfactsProcessReader(
  bin: string,
  snapshot: SnapshotSubtree = snapshotSubtree,
): () => Promise<Map<Pid, Process>> {
  return async () => processesFromOsfacts(await snapshot(bin, [1]));
}

// ── Linux: system/network reader ─────────────────────────────────────────

function linuxReader(osfactsBin: string): ProcReader {
  const readCpuCores = createCpuCoresReader();
  const readProcesses = createOsfactsProcessReader(osfactsBin);
  const readNetwork = createNetReader(async () =>
    filterLoopback(
      parseProcNetDev(await readFile("/proc/net/dev", "utf-8")),
    ),
  );
  return {
    os: "linux",
    readCpuCores,
    readNetwork,
    readSystem: async () => {
      const [loadAvgs, mem, up] = await Promise.all([
        readFile("/proc/loadavg", "utf-8").then((s) =>
          s.split(/\s+/).slice(0, 3).map(Number),
        ),
        readFile("/proc/meminfo", "utf-8").then(parseMeminfo),
        readFile("/proc/uptime", "utf-8").then((s) => Number(s.split(" ")[0])),
      ]);
      // Synchronous cached observation — never awaited (see readRootDiskUsage).
      const disk = readRootDiskUsage();
      return {
        loadAvg: [loadAvgs[0] ?? 0, loadAvgs[1] ?? 0, loadAvgs[2] ?? 0],
        memUsed: mem.total - mem.available,
        memTotal: mem.total,
        // Swap parity of memUsed = total − available: used is what's committed
        // to swap (SwapTotal − SwapFree). 0/0 when swap is off.
        swapUsed: mem.swapTotal - mem.swapFree,
        swapTotal: mem.swapTotal,
        ...disk,
        uptime: up,
        os: "linux",
        hostname: hostname(),
      };
    },
    readProcesses,
  };
}

interface MemInfo {
  total: number;
  available: number;
  /** Swap total / free in bytes, from `SwapTotal` / `SwapFree`. Both 0 on a
   *  host with no swap configured — the reader derives `swapUsed = total −
   *  free`, the swap parity of `memUsed = total − available`. */
  swapTotal: number;
  swapFree: number;
}

export function parseMeminfo(s: string): MemInfo {
  const get = (key: string): number => {
    const m = s.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
    return m && m[1] !== undefined ? Number(m[1]) * 1024 : 0;
  };
  return {
    total: get("MemTotal"),
    available: get("MemAvailable"),
    swapTotal: get("SwapTotal"),
    swapFree: get("SwapFree"),
  };
}

/** The exec shape for darwin system/network probes. Process inspection
 * itself never reaches this boundary; it is owned by osfacts-client. */
export type ExecFn = (
  file: string,
  args: readonly string[],
  options?: {
    timeout?: number;
    killSignal?: NodeJS.Signals;
    maxBuffer?: number;
  },
) => Promise<{ stdout: string }>;

const CHILD_EXEC_OPTS = {
  timeout: 20_000,
  killSignal: "SIGKILL",
  maxBuffer: 16 * 1024 * 1024,
} as const;

export type BudgetedRun = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

/** One budgeted subprocess boundary for vm_stat/sysctl/netstat. */
export const budgetedExec =
  (execImpl: ExecFn): BudgetedRun =>
  (file, args) =>
    execImpl(file, args, CHILD_EXEC_OPTS);

/** Parse `vm_stat` (darwin) into a cache-aware *available* byte count, so
 *  the darwin path can mean the same thing as linux's MemAvailable-based
 *  number (`darwinReader().readSystem` does `total - available`).
 *
 *  macOS `os.freemem()` counts only truly-free Mach pages, so
 *  `total - free` reports a host as 80-95% used even when most of that is
 *  reclaimable file cache. We sum the reclaimable classes — free, inactive,
 *  speculative, and purgeable pages — which are all evictable under
 *  pressure, so they count as *available*, matching Linux's MemAvailable
 *  heuristic.
 *
 *  These are mutually exclusive *LRU-list* counters: every physical page
 *  sits on exactly one of the free / active / inactive / speculative lists,
 *  so free + inactive + speculative never double-counts a page. ("Pages
 *  purgeable" overlaps active/inactive, but purgeable pages are reclaimed
 *  first under pressure and are almost always on the inactive list already
 *  — adding them is a small, bounded over-count, not a systematic one.) We
 *  deliberately do NOT add "File-backed pages": that counter tallies *all*
 *  file-backed pages regardless of LRU list, so it re-counts the
 *  file-backed pages already in "Pages inactive" and the read-ahead pages
 *  in "Pages speculative" — adding it would let `available` exceed physical
 *  total and drive `memUsed` (total - available) negative. The caller still
 *  clamps the subtraction at 0 as a final guard against the bounded
 *  purgeable overlap.
 *
 *  This returns only what vm_stat knows — available bytes. The physical
 *  total is a different, non-volatile source (`totalmem()`/`hw.memsize`)
 *  the reader owns; it pairs total with this available where the two are
 *  genuinely co-present. `pageSize` defaults to the size in the header
 *  (`(page size of N bytes)`); the param lets tests pin it. Pure — no
 *  clock or platform state — to stay unit-testable, mirroring
 *  parseNetstatIb. */
export function parseVmStat(
  stdout: string,
  pageSize?: number,
): { available: number } {
  const headerMatch = stdout.match(/page size of (\d+) bytes/);
  const size =
    pageSize ?? (headerMatch?.[1] !== undefined ? Number(headerMatch[1]) : 4096);
  // Each count line is `Label:   <count>.` — read the integer after the
  // label's colon, defaulting absent classes to 0.
  const pages = (label: string): number => {
    const m = stdout.match(
      new RegExp(`^${label}:\\s+(\\d+)\\.`, "m"),
    );
    return m && m[1] !== undefined ? Number(m[1]) : 0;
  };
  const reclaimable =
    pages("Pages free") +
    pages("Pages inactive") +
    pages("Pages speculative") +
    pages("Pages purgeable");
  return { available: size * reclaimable };
}

/** Parse `sysctl -n vm.swapusage` (darwin) into used/total swap bytes — the
 *  darwin source for the same `swapUsed`/`swapTotal` linux reads from
 *  `/proc/meminfo`. The line is `total = 2048.00M  used = 1234.50M  free =
 *  813.50M  (encrypted)`; sizes carry a `M`/`G` suffix that macOS scales by
 *  1024 (MiB/GiB), so we multiply accordingly. Absent/garbage fields default to
 *  0, so a host with swap disabled (`total = 0.00M`) reads as 0/0. Pure — no
 *  subprocess — to stay unit-testable, mirroring parseVmStat / parseMeminfo. */
export function parseSwapusage(stdout: string): {
  swapUsed: number;
  swapTotal: number;
} {
  const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  const bytesFor = (field: string): number => {
    const m = stdout.match(new RegExp(`${field}\\s*=\\s*([\\d.]+)([KMG])`));
    if (!m || m[1] === undefined || m[2] === undefined) return 0;
    return Math.round(Number(m[1]) * (UNIT[m[2]] ?? 1));
  };
  return { swapUsed: bytesFor("used"), swapTotal: bytesFor("total") };
}

/** Exported (unlike `linuxReader`, whose reads are plain `/proc` file I/O)
 *  so tests can construct the reader with a fake `ExecFn` and exercise the
 *  child discipline — enrichment single-flight, kill budgets — end-to-end
 *  without real subprocesses. `execImpl` defaults to the real promisified
 *  execFile in production (`createProcReader` passes nothing) — executable +
 *  argv, no shell, so the kill budget provably targets the utility itself.
 *
 *  EVERY child rides `CHILD_EXEC_OPTS` — structurally, not by discipline:
 *  the injected exec is wrapped ONCE in `budgetedExec` and every read
 *  closure (and the enricher) spawns through the narrowed `run`, so an
 *  unbudgeted child cannot be spelled. These reads sit under
 *  settlement-dependent non-overlap guards (the framework poll's latch for
 *  the collections, main.ts's `singleFlight` for the system tick), so an
 *  unbudgeted hung child wouldn't just stall a tick — it would silently
 *  freeze its collection/cell for the life of the agent. A budget-killed
 *  child settles as a rejection, which the framework log-skip-continues on
 *  LATER ticks and the system tick's catch logs — one lost sample, next
 *  fire re-samples. The SEED (T+0) read is the exception: the framework's
 *  poll contract makes a seed rejection permanently fatal to that
 *  collection, which is why serveAgent observes `runtime.done` and exits
 *  loud instead of serving a silently-dead table for the process's life. */
export function darwinReader(
  execImpl: ExecFn,
  osfactsBin: string,
): ProcReader {
  const readCpuCores = createCpuCoresReader();
  const run = budgetedExec(execImpl);
  const readProcesses = createOsfactsProcessReader(osfactsBin);
  const readNetwork = createNetReader(async () => {
    const { stdout } = await run("netstat", ["-ib"]);
    return filterLoopback(parseNetstatIb(stdout));
  });
  return {
    os: "darwin",
    readCpuCores,
    readNetwork,
    readSystem: async () => {
      // os.loadavg() works on darwin; sysctl fallback only needed for
      // very old node versions.
      const la = loadavg();
      // os.freemem() on darwin counts only truly-free pages, so it would
      // over-report usage by ignoring reclaimable cache. Derive a
      // cache-aware "available" from vm_stat instead, then mirror linux's
      // `total - available` (kept inline, like linuxReader). totalmem() is
      // the authoritative physical total — vm_stat reports only page
      // counts, so total and available come from the two distinct sources
      // and are assembled here.
      // swapusage is a separate sysctl from vm_stat (which reports swapin/out
      // *counts*, not usage), so it rides alongside as its own subprocess.
      // Degrade to empty on failure so the snapshot still resolves as 0/0 swap.
      const [{ stdout }, swapOut] = await Promise.all([
        run("vm_stat", []),
        run("sysctl", ["-n", "vm.swapusage"]).catch(() => ({
          stdout: "",
        })),
      ]);
      // Synchronous cached observation — never awaited (see readRootDiskUsage).
      const disk = readRootDiskUsage();
      const total = totalmem();
      const available = parseVmStat(stdout).available;
      return {
        loadAvg: [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0],
        // Clamp at 0: vm_stat's "Pages purgeable" can overlap the inactive
        // list, so `available` may marginally exceed `total`; never report
        // negative usage.
        memUsed: Math.max(0, total - available),
        memTotal: total,
        ...parseSwapusage(swapOut.stdout),
        ...disk,
        uptime: uptime(),
        os: "darwin",
        hostname: hostname(),
      };
    },
    readProcesses,
  };
}

// ── Stub fallback (unknown OS / unsupported environment) ────────────────

function stubReader(): ProcReader {
  const readCpuCores = createCpuCoresReader();
  return {
    os: "unknown",
    readCpuCores,
    // No universal network-counter source off linux/darwin — report no
    // interfaces rather than guess.
    readNetwork: async () => new Map<IfaceName, NetInterface>(),
    readSystem: async () => {
      const la = loadavg();
      // Known limitation: total-free undercounts reclaimable (cache /
      // inactive / purgeable) memory on darwin-like kernels — the very
      // miscount darwinReader fixes via vm_stat. It's tolerated here
      // because macOS always dispatches to darwinReader (createProcReader),
      // so this stub is never the Mac path; it's the last-resort fallback
      // for genuinely-unknown platforms with no vm_stat / /proc to query.
      // `statfs` still works on many such platforms; `readRootDiskUsage`
      // degrades to zeros where it doesn't.
      const disk = readRootDiskUsage();
      return {
        loadAvg: [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0],
        memUsed: totalmem() - freemem(),
        memTotal: totalmem(),
        // No universal swap source off linux/darwin — report 0/0 rather than
        // guess; `swapPct` reads it as "unavailable".
        swapUsed: 0,
        swapTotal: 0,
        ...disk,
        uptime: uptime(),
        os: "unknown",
        hostname: hostname(),
      };
    },
    readProcesses: async () => {
      // Surface the agent's own process so the demo still shows
      // something even on platforms osfacts does not support.
      const out = new Map<Pid, Process>();
      out.set(process.pid, {
        command: `${process.execPath} ${process.argv.slice(1).join(" ")}`,
        ppid: process.ppid,
        listeners: [],
        unreadableErrno: "ENOTSUP",
      });
      return out;
    },
  };
}
