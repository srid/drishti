/**
 * Cross-platform process + system info readers.
 *
 *   - `linux`: parse `/proc/<pid>/{stat,status,cmdline}` + `/proc/meminfo`
 *     + `/proc/loadavg`. Pure file reads, universally readable by the
 *     running user.
 *   - `darwin`: shell out to `ps -axo pid=,user=,pcpu=,pmem=,rss=,comm=` and
 *     `sysctl -n vm.loadavg hw.memsize`. The `ps` command is in every
 *     base install; sysctl reads are unprivileged.
 *
 * Universality is the point. The plan considered tailing logs and cut it
 * — no plain-text log file is universally readable, universally present,
 * and actively updating across darwin/linux in 2025. Process metrics
 * are.
 */

import { exec as execCb } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
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
} from "../common/surface";

const exec = promisify(execCb);

/** Hardware/OS observations only — pollIntervalMs is owned by the
 *  agent's run loop and spliced in at publish time. */
type RawSystemInfo = Omit<SystemInfo, "pollIntervalMs">;

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
      return {
        loadAvg: [loadAvgs[0] ?? 0, loadAvgs[1] ?? 0, loadAvgs[2] ?? 0],
        memUsed: mem.total - mem.available,
        memTotal: mem.total,
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
      // `USER_HZ` — kernel jiffies-per-second. The kernel reports
      // utime/stime in jiffies; we divide by Δseconds × USER_HZ to get
      // "fraction of a core during this window". `getconf CLK_TCK` is
      // 100 on every standard linux kernel build (it's a Kconfig at
      // CONFIG_HZ_100/250/300/1000 with 100 as the universal default).
      // Hardcoding it avoids an extra subprocess on every poll.
      const USER_HZ = 100;
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
          memPct: raw.memPct,
          rssBytes: raw.rssBytes,
          command: raw.command,
          cwd: raw.cwd,
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
}

function parseMeminfo(s: string): MemInfo {
  const get = (key: string): number => {
    const m = s.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
    return m && m[1] !== undefined ? Number(m[1]) * 1024 : 0;
  };
  return { total: get("MemTotal"), available: get("MemAvailable") };
}

interface LinuxProcRaw {
  user: string;
  /** utime + stime, in clock ticks. */
  ticks: number;
  /** /proc/<pid>/stat field 22 — ticks-since-boot at fork; the
   *  tombstone we use to detect PID recycling between polls. */
  startTime: number;
  memPct: number;
  /** Resident set size in bytes (VmRSS × 1024). */
  rssBytes: number;
  command: string;
  cwd: string;
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
    // /proc/<pid>/stat: see proc(5). After comm (in parens — may contain
    // spaces), fields are space-separated. utime + stime are fields 14-15
    // (0-indexed 11-12 after the comm field, since state is at index 0).
    const commEnd = statRaw.lastIndexOf(")");
    const tail = statRaw.slice(commEnd + 2).split(" ");
    const utime = Number(tail[11] ?? 0);
    const stime = Number(tail[12] ?? 0);
    const startTime = Number(tail[19] ?? 0);
    const vmRssMatch = statusRaw.match(/^VmRSS:\s+(\d+)\s+kB/m);
    const rssKb =
      vmRssMatch && vmRssMatch[1] !== undefined ? Number(vmRssMatch[1]) : 0;
    const userMatch = statusRaw.match(/^Uid:\s+(\d+)/m);
    const uid =
      userMatch && userMatch[1] !== undefined ? Number(userMatch[1]) : 0;
    const total = totalmem();
    const memPct = total > 0 ? (100 * rssKb * 1024) / total : 0;
    const command =
      cmdlineRaw.length > 0
        ? cmdlineRaw.replace(/\0/g, " ").trim()
        : statRaw.slice(statRaw.indexOf("(") + 1, commEnd);
    return {
      // Best-effort user display — /etc/passwd lookup synchronous would
      // block, so render the uid (and humanize uid 0 → "root").
      user: uid === 0 ? "root" : String(uid),
      ticks: utime + stime,
      startTime,
      memPct: round2(memPct),
      rssBytes: rssKb * 1024,
      command: truncate(command, PROC_STRING_MAX),
      cwd: truncate(cwdResult, PROC_STRING_MAX),
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

// Compiled once — matches `ps -axo pid=,user=,pcpu=,pmem=,rss=,comm=` lines.
// `comm` is greedy/last (it can contain spaces), so it stays the trailing
// `(.*)`; the integer `rss` (KB) sits just before it.
const PS_LINE_RE = /^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;

/** Parse one `ps -axo pid=,user=,pcpu=,pmem=,rss=,comm=` line into a
 *  `Process`. `rss` is in KB on macOS, so ×1024 for `rssBytes`. Returns
 *  null for lines that don't match (blank/garbage) so the caller skips
 *  them. Pure — no clock or platform state — to stay unit-testable. */
export function parsePsLine(line: string): [Pid, Process] | null {
  const m = line.trim().match(PS_LINE_RE);
  if (!m) return null;
  const [, pidStr, user, cpu, mem, rssKb, command] = m;
  if (!pidStr || !user || !cpu || !mem || !rssKb || !command) return null;
  return [
    Number(pidStr),
    {
      user,
      cpuPct: Number(cpu),
      memPct: Number(mem),
      rssBytes: Number(rssKb) * 1024,
      command: truncate(command, PROC_STRING_MAX),
      // darwin has no cheap per-pid cwd source (`lsof -p` per pid is a
      // fork per row); leave blank — the UI hides it when empty.
      cwd: "",
    },
  ];
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
      const total = totalmem();
      const free = freemem();
      return {
        loadAvg: [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0],
        memUsed: total - free,
        memTotal: total,
        uptime: uptime(),
        os: "darwin",
        hostname: hostname(),
      };
    },
    readProcesses: async () => {
      const { stdout } = await exec(
        "ps -axo pid=,user=,pcpu=,pmem=,rss=,comm=",
      );
      const out = new Map<Pid, Process>();
      for (const line of stdout.split("\n")) {
        const parsed = parsePsLine(line);
        if (parsed) out.set(parsed[0], parsed[1]);
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
      return {
        loadAvg: [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0],
        memUsed: totalmem() - freemem(),
        memTotal: totalmem(),
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
        memPct: 0,
        rssBytes: 0,
        command: `${process.execPath} ${process.argv.slice(1).join(" ")}`,
        cwd: process.cwd(),
      });
      return out;
    },
  };
}

// ── Tiny helpers ─────────────────────────────────────────────────────────

/** Wire cap for per-process string fields (command, cwd, …). One
 *  constant so a change to the limit stays in parity across platforms. */
const PROC_STRING_MAX = 200;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
