/**
 * Cross-platform process + system info readers.
 *
 *   - `linux`: parse `/proc/<pid>/{stat,status,cmdline}` + `/proc/meminfo`
 *     + `/proc/loadavg`. Pure file reads, universally readable by the
 *     running user.
 *   - `darwin`: shell out to `ps -axo pid=,user=,pcpu=,rss=,comm=` and
 *     `sysctl -n vm.loadavg hw.memsize`. The `ps` command is in every
 *     base install; sysctl reads are unprivileged.
 *
 * Universality is the point. The plan considered tailing logs and cut it
 * — no plain-text log file is universally readable, universally present,
 * and actively updating across darwin/linux in 2025. Process metrics
 * are.
 */

import { exec as execCb } from "node:child_process";
import { readFile, readdir, readlink, statfs } from "node:fs/promises";
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
import type {
  CoreId,
  CpuCore,
  IfaceName,
  NetInterface,
  Pid,
  Process,
  SystemInfo,
} from "drishti-common";

const exec = promisify(execCb);

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
 *  on `SystemSchema.diskUsed`. Degrades to zeros if `statfs` is unavailable
 *  (unknown platform) so the system snapshot still resolves — `pctOf` then
 *  reads it as "unavailable". */
async function readRootDiskUsage(): Promise<{
  diskUsed: number;
  diskTotal: number;
}> {
  try {
    return diskBytesFromStatfs(await statfs("/"));
  } catch {
    // `statfs` is unavailable on some platforms (e.g. Windows). Degrade to
    // zeros so the system snapshot still resolves — `pctOf` renders it as
    // "unavailable" (0/0 → 0%). Safe to swallow: the caller merges these
    // zeros into the snapshot and the UI shows nothing rather than crashing.
    return { diskUsed: 0, diskTotal: 0 };
  }
}

export function createProcReader(): ProcReader {
  const plat = platform();
  if (plat === "linux") return linuxReader();
  if (plat === "darwin") return darwinReader();
  return stubReader();
}

// ── Linux: /proc reader ─────────────────────────────────────────────────

function linuxReader(): ProcReader {
  const readCpuCores = createCpuCoresReader();
  const readNetwork = createNetReader(async () =>
    filterLoopback(
      parseProcNetDev(await readFile("/proc/net/dev", "utf-8")),
    ),
  );
  // Per-PID previous tick reading so we can compute "% of one core
  // during the last poll window" — the metric `top`/`htop` show.
  // Without this delta, dividing lifetime ticks by lifetime uptime
  // returns the process's *average* CPU usage since fork — which is
  // ~0 for any long-running mostly-idle daemon. round2 then snaps it
  // to 0.0 and every row in the UI reads dead. (`startTime` is the
  // PID's fork-time-in-ticks-since-boot; we use it as a tombstone so
  // pid recycling doesn't compute a delta against a different process'
  // counters.)
  const prevPid = new Map<number, { ticks: number; startTime: number }>();
  let prevWallMs = 0;
  // Host boot time as epoch ms, resolved once and reused. `/proc/<pid>/stat`
  // gives a process's start as ticks-since-boot; `bootEpochMs + startTicks/HZ`
  // turns that into an absolute wall-clock instant. Boot time is fixed, so
  // caching it (rather than recomputing `now - uptime` each tick, whose
  // centisecond uptime + ms now would jitter) keeps `startedAtMs` stable per
  // pid across polls.
  let bootEpochMs = 0;
  return {
    os: "linux",
    readCpuCores,
    readNetwork,
    readSystem: async () => {
      const [loadAvgs, mem, up, disk] = await Promise.all([
        readFile("/proc/loadavg", "utf-8").then((s) =>
          s.split(/\s+/).slice(0, 3).map(Number),
        ),
        readFile("/proc/meminfo", "utf-8").then(parseMeminfo),
        readFile("/proc/uptime", "utf-8").then((s) => Number(s.split(" ")[0])),
        readRootDiskUsage(),
      ]);
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
    readProcesses: async () => {
      const entries = await readdir("/proc");
      const pids = entries.filter((e) => /^\d+$/.test(e)).map((e) => Number(e));
      // Avoid /proc churn racing the read: ENOENT on a vanished pid is
      // expected — just skip it.
      const results = await Promise.allSettled(
        pids.map((pid) => readProcLinuxRaw(pid)),
      );
      const nowMs = Date.now();
      // Resolve the boot epoch once, on the first poll: now − uptime.
      if (bootEpochMs === 0) {
        const up = Number(
          (await readFile("/proc/uptime", "utf-8")).split(" ")[0],
        );
        bootEpochMs = nowMs - up * 1000;
      }
      const winSec = prevWallMs > 0 ? (nowMs - prevWallMs) / 1000 : 0;
      const out = new Map<Pid, Process>();
      const seen = new Set<number>();
      for (let i = 0; i < pids.length; i++) {
        const r = results[i];
        const pid = pids[i];
        if (r === undefined || pid === undefined) continue;
        if (r.status !== "fulfilled" || r.value === null) continue;
        const raw = r.value;
        seen.add(pid);
        const prev = prevPid.get(pid);
        let cpuPct = 0;
        if (prev && prev.startTime === raw.startTime && winSec > 0) {
          const deltaTicks = raw.ticks - prev.ticks;
          cpuPct = (deltaTicks / (winSec * USER_HZ)) * 100;
          if (cpuPct < 0) cpuPct = 0;
        }
        prevPid.set(pid, { ticks: raw.ticks, startTime: raw.startTime });
        out.set(pid, {
          user: raw.user,
          cpuPct: round2(cpuPct),
          rssBytes: raw.rssBytes,
          command: raw.command,
          cwd: raw.cwd,
          ppid: raw.ppid,
          state: raw.state,
          nice: raw.nice,
          threads: raw.threads,
          startedAtMs: Math.round(bootEpochMs + raw.startTime * USER_HZ_MS),
        });
      }
      // Evict dead pids so the map doesn't grow without bound.
      for (const pid of prevPid.keys()) {
        if (!seen.has(pid)) prevPid.delete(pid);
      }
      prevWallMs = nowMs;
      return out;
    },
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

interface LinuxProcRaw {
  user: string;
  /** utime + stime, in clock ticks. */
  ticks: number;
  /** /proc/<pid>/stat field 22 — ticks-since-boot at fork; the
   *  tombstone we use to detect PID recycling between polls AND the offset
   *  the reader turns into a wall-clock start time via the boot epoch. */
  startTime: number;
  /** Resident set size in bytes (VmRSS × 1024). */
  rssBytes: number;
  command: string;
  cwd: string;
  ppid: Pid;
  /** Single-char kernel state code (R/S/D/Z/T/I/…). */
  state: string;
  nice: number;
  threads: number;
}

/** The subset of `/proc/<pid>/stat` (proc(5)) drishti reads. Pure — no I/O —
 *  so it's unit-testable against a fixture, mirroring `parsePsLine` /
 *  `parseMeminfo`. After `comm` (wrapped in parens and free to contain spaces,
 *  so we split on the LAST `)`), the remaining fields are space-separated and
 *  index from `state` at 0:
 *    state=0  ppid=1  utime=11  stime=12  nice=16  num_threads=17  starttime=19
 *  Returns null when there's no `)` to split on (not a stat line). Absent
 *  trailing fields default to 0. */
export function parseProcStat(stat: string): {
  comm: string;
  state: string;
  ppid: number;
  ticks: number;
  nice: number;
  threads: number;
  startTime: number;
} | null {
  const commStart = stat.indexOf("(");
  const commEnd = stat.lastIndexOf(")");
  if (commStart < 0 || commEnd < commStart) return null;
  const comm = stat.slice(commStart + 1, commEnd);
  const tail = stat.slice(commEnd + 2).split(" ");
  return {
    comm,
    state: tail[0] ?? "",
    ppid: Number(tail[1] ?? 0),
    ticks: Number(tail[11] ?? 0) + Number(tail[12] ?? 0),
    nice: Number(tail[16] ?? 0),
    threads: Number(tail[17] ?? 0),
    startTime: Number(tail[19] ?? 0),
  };
}

async function readProcLinuxRaw(pid: number): Promise<LinuxProcRaw | null> {
  try {
    // `/proc/<pid>/cwd` is a symlink that EACCES for other-user pids
    // and ENOENT for kernel threads. The `.catch(() => "")` resolves
    // the rejection in place so it can't bubble out of the surrounding
    // `Promise.all` and discard the rest of the row's reads.
    const [statRaw, statusRaw, cmdlineRaw, cwdResult] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf-8"),
      readFile(`/proc/${pid}/status`, "utf-8"),
      readFile(`/proc/${pid}/cmdline`, "utf-8"),
      readlink(`/proc/${pid}/cwd`).catch(() => ""),
    ]);
    const stat = parseProcStat(statRaw);
    if (stat === null) return null;
    const vmRssMatch = statusRaw.match(/^VmRSS:\s+(\d+)\s+kB/m);
    const rssKb =
      vmRssMatch && vmRssMatch[1] !== undefined ? Number(vmRssMatch[1]) : 0;
    const userMatch = statusRaw.match(/^Uid:\s+(\d+)/m);
    const uid =
      userMatch && userMatch[1] !== undefined ? Number(userMatch[1]) : 0;
    const command =
      cmdlineRaw.length > 0 ? cmdlineRaw.replace(/\0/g, " ").trim() : stat.comm;
    return {
      // Best-effort user display — /etc/passwd lookup synchronous would
      // block, so render the uid (and humanize uid 0 → "root").
      user: uid === 0 ? "root" : String(uid),
      ticks: stat.ticks,
      startTime: stat.startTime,
      rssBytes: rssKb * 1024,
      command: truncate(command, PROC_STRING_MAX),
      cwd: truncate(cwdResult, PROC_STRING_MAX),
      ppid: stat.ppid,
      state: stat.state,
      nice: stat.nice,
      threads: stat.threads,
    };
  } catch {
    // ENOENT is expected for PIDs that vanish between readdir and the
    // per-file reads. Any other error (EPERM on a kernel thread, I/O
    // error, parse failure) is also safe to skip — the worst outcome is
    // a missing row in the process table for one poll cycle.
    return null;
  }
}

// ── darwin: ps + sysctl reader ──────────────────────────────────────────

// Compiled once — matches `ps -axo pid=,user=,pcpu=,rss=,ppid=,nice=,state=,comm=`
// lines. `comm` is greedy/last (it can contain spaces), so it stays the
// trailing `(.*)`; `state` is a no-space token like `S`/`Ss`/`R+`; `nice`
// can be negative. All of pid/user/pcpu/rss/ppid/nice/state precede comm.
const PS_LINE_RE =
  /^(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/;

/** The subset of `ps -axo …` fields a single ps line carries. `cwd`,
 *  `threads`, and `startedAtMs` are deliberately absent — a ps line has none
 *  of them — so the final `Process` is assembled in `darwinReader.readProcesses`
 *  where the lsof-derived cwd map is in scope. Mirrors linux's
 *  `LinuxProcRaw` → `Process` split so neither parser fabricates a field it
 *  cannot see (no placeholder `cwd: ""` that a caller is silently obliged to
 *  overwrite). */
interface DarwinProcRaw {
  pid: Pid;
  user: string;
  cpuPct: number;
  /** Resident set size in bytes (ps reports KB, ×1024 here). */
  rssBytes: number;
  command: string;
  ppid: Pid;
  /** Single-char kernel state code (R/S/D/Z/T/I/…). */
  state: string;
  nice: number;
}

/** Parse one `ps -axo pid=,user=,pcpu=,rss=,ppid=,nice=,state=,comm=` line
 *  into a `DarwinProcRaw`. `rss` is in KB on macOS, so ×1024 for `rssBytes`;
 *  the multi-char `state` token's trailing flags (`+`, `s`, …) are dropped to
 *  the leading single-char code for parity with linux. Returns null for lines
 *  that don't match (blank/garbage) so the caller skips them. Pure — no clock
 *  or platform state — to stay unit-testable. */
export function parsePsLine(line: string): DarwinProcRaw | null {
  const m = line.trim().match(PS_LINE_RE);
  if (!m) return null;
  const [, pidStr, user, cpu, rssKb, ppid, nice, state, command] = m;
  if (
    !pidStr ||
    !user ||
    !cpu ||
    !rssKb ||
    !ppid ||
    !nice ||
    !state ||
    !command
  )
    return null;
  return {
    pid: Number(pidStr),
    user,
    cpuPct: Number(cpu),
    rssBytes: Number(rssKb) * 1024,
    command: truncate(command, PROC_STRING_MAX),
    ppid: Number(ppid),
    state: state[0] ?? "",
    nice: Number(nice),
  };
}

/** Parse `lsof -nP -d cwd -Fpn` field output into a pid→cwd map — darwin's
 *  batch equivalent of linux's per-pid `readlink(/proc/<pid>/cwd)`, in one
 *  fork rather than one per row. lsof's `-F` mode emits one set per process: a
 *  `p<pid>` line, then (for the single cwd descriptor `-d cwd` selects) an
 *  `n<path>` line. We track the pid from each `p` line and attach the next `n`
 *  path to it. A process whose cwd lsof cannot resolve — other-user pids
 *  without root — emits no `n` line and stays absent from the map, so the
 *  caller's `?? ""` reproduces linux's EACCES-to-blank fallback. Any other
 *  field line (e.g. an `f` fd marker) is ignored, so the parse is robust to
 *  lsof's exact field framing. Pure — no I/O — to stay unit-testable,
 *  mirroring parsePsLine / parseVmStat / parseNetstatIb. */
export function parseLsofCwd(stdout: string): Map<Pid, string> {
  const out = new Map<Pid, string>();
  let pid: Pid | null = null;
  for (const line of stdout.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid !== null) {
      out.set(pid, truncate(line.slice(1), PROC_STRING_MAX));
      pid = null; // consume: one cwd per process (-d cwd guarantees one n per p)
    }
  }
  return out;
}

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
 *  clock or platform state — to stay unit-testable, mirroring parsePsLine
 *  / parseNetstatIb. */
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

function darwinReader(): ProcReader {
  const readCpuCores = createCpuCoresReader();
  const readNetwork = createNetReader(async () => {
    const { stdout } = await exec("netstat -ib");
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
      const [{ stdout }, swapOut, disk] = await Promise.all([
        exec("vm_stat"),
        exec("sysctl -n vm.swapusage").catch(() => ({ stdout: "" })),
        readRootDiskUsage(),
      ]);
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
    readProcesses: async () => {
      // ps gives the rows; lsof gives cwd for every pid in a single fork (not
      // a fork per row), so the two run concurrently. lsof failing or being
      // absent degrades to blank cwds rather than dropping the snapshot —
      // mirroring linux's per-pid EACCES-to-blank fallback.
      const [{ stdout: psOut }, lsof] = await Promise.all([
        exec("ps -axo pid=,user=,pcpu=,rss=,ppid=,nice=,state=,comm="),
        exec("lsof -nP -d cwd -Fpn").catch(() => ({ stdout: "" })),
      ]);
      const cwdByPid = parseLsofCwd(lsof.stdout);
      const out = new Map<Pid, Process>();
      for (const line of psOut.split("\n")) {
        const raw = parsePsLine(line);
        if (!raw) continue;
        // Single Process-construction site, like linuxReader: cwd from the
        // lsof map; threads/startedAtMs null — darwin's ps has no cheap source.
        out.set(raw.pid, {
          user: raw.user,
          cpuPct: raw.cpuPct,
          rssBytes: raw.rssBytes,
          command: raw.command,
          cwd: cwdByPid.get(raw.pid) ?? "",
          ppid: raw.ppid,
          state: raw.state,
          nice: raw.nice,
          threads: null,
          startedAtMs: null,
        });
      }
      return out;
    },
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
      const disk = await readRootDiskUsage();
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
      // something even on platforms without /proc or BSD ps.
      const out = new Map<Pid, Process>();
      out.set(process.pid, {
        user: process.env.USER ?? "unknown",
        cpuPct: 0,
        rssBytes: 0,
        command: `${process.execPath} ${process.argv.slice(1).join(" ")}`,
        cwd: process.cwd(),
        ppid: process.ppid,
        state: "",
        nice: 0,
        threads: null,
        startedAtMs: null,
      });
      return out;
    },
  };
}

// ── Tiny helpers ─────────────────────────────────────────────────────────

/** Wire cap for per-process string fields (command, cwd, …). One
 *  constant so a change to the limit stays in parity across platforms. */
const PROC_STRING_MAX = 200;

// `USER_HZ` — kernel jiffies-per-second. The kernel reports utime/stime in
// jiffies; we divide by Δseconds × USER_HZ to get "fraction of a core during
// this window". `getconf CLK_TCK` is 100 on every standard linux kernel build
// (it's a Kconfig at CONFIG_HZ_100/250/300/1000 with 100 as the universal
// default). Hardcoding it avoids an extra subprocess on every poll.
const USER_HZ = 100;
const USER_HZ_MS = 1000 / USER_HZ; // ms per clock tick

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
