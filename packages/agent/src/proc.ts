/** Cross-platform host observation through osfacts V2.
 *
 * osfacts is the only process, socket, CPU, memory, swap, uptime, network and
 * disk fact source. Node's os module is used only for host identity and OS
 * selection; there is no lsof/ps, /proc, sysctl, vm_stat, netstat or statfs
 * fallback here.
 */

import { hostname, platform } from "node:os";
import {
  host as readOsfactsHost,
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
  UnclaimedListener,
  UnclaimedListenerId,
} from "drishti-common";
import { OsfactsSourceError } from "drishti-common/source-errors";

type RawSystemInfo = Omit<
  SystemInfo,
  "pollIntervalMs" | "cpuPct" | "coreCount"
>;

export interface HostFrame {
  system: RawSystemInfo;
  cpuCores: Map<CoreId, CpuCore>;
  networkInterfaces: Map<IfaceName, NetInterface>;
}

export interface ProcessFrame {
  processes: Map<Pid, Process>;
  unclaimedListeners: Map<UnclaimedListenerId, UnclaimedListener>;
}

export interface ProcReader {
  os: SystemInfo["os"];
  readSystem: () => Promise<RawSystemInfo>;
  readProcesses: () => Promise<Map<Pid, Process>>;
  readUnclaimedListeners: () => Promise<
    Map<UnclaimedListenerId, UnclaimedListener>
  >;
  readCpuCores: () => Promise<Map<CoreId, CpuCore>>;
  readNetwork: () => Promise<Map<IfaceName, NetInterface>>;
}

export interface NetCounters {
  rxBytes: number;
  txBytes: number;
}

export interface CpuCounters {
  userUs: number;
  systemUs: number;
  idleUs: number;
  otherUs: number;
}

export function computeNetThroughput(
  prev: ReadonlyMap<string, NetCounters>,
  cur: ReadonlyMap<string, NetCounters>,
  winSec: number,
): Map<IfaceName, NetInterface> {
  const out = new Map<IfaceName, NetInterface>();
  for (const [name, current] of cur) {
    if (name === "lo" || name === "lo0") continue;
    const previous = prev.get(name);
    const rxRate =
      previous && winSec > 0
        ? Math.max(0, (current.rxBytes - previous.rxBytes) / winSec)
        : 0;
    const txRate =
      previous && winSec > 0
        ? Math.max(0, (current.txBytes - previous.txBytes) / winSec)
        : 0;
    out.set(name, {
      ...current,
      rxRate: Math.round(rxRate),
      txRate: Math.round(txRate),
    });
  }
  return out;
}

export function computeCpuUsage(
  prev: ReadonlyMap<number, CpuCounters>,
  cur: ReadonlyMap<number, CpuCounters>,
): Map<CoreId, CpuCore> {
  const out = new Map<CoreId, CpuCore>();
  for (const [core, current] of cur) {
    const previous = prev.get(core);
    let usagePct = 0;
    if (previous) {
      const idleDelta = current.idleUs - previous.idleUs;
      const totalDelta =
        current.userUs +
        current.systemUs +
        current.idleUs +
        current.otherUs -
        (previous.userUs +
          previous.systemUs +
          previous.idleUs +
          previous.otherUs);
      if (totalDelta > 0)
        usagePct = (1 - Math.max(0, idleDelta) / totalDelta) * 100;
    }
    out.set(core, {
      usagePct: Math.round(Math.max(0, Math.min(100, usagePct)) * 10) / 10,
      // V2 deliberately reports cumulative CPU time, not model/frequency.
      speedMHz: 0,
      model: "",
    });
  }
  return out;
}

function assertNoSourceErrors(reading: OsfactsReading, operation: string): void {
  if (reading.errors.length === 0) return;
  throw new OsfactsSourceError({
    operation,
    errors: reading.errors.map(({ source, code }) => ({ source, code })),
  });
}

function requireFact<T>(value: T | undefined, name: string): T {
  if (value === undefined)
    throw new Error(`osfacts host response omitted requested ${name} fact`);
  return value;
}

export function processesFromOsfacts(reading: OsfactsReading): ProcessFrame {
  assertNoSourceErrors(reading, "snapshot");
  const processes = new Map<Pid, Process>();
  const memory = new Map(reading.memory.map((row) => [row.pid, row.rssBytes]));
  const starts = new Map(
    reading.startTimes.map((row) => [row.pid, row.startUnixUs / 1000]),
  );
  const unreadable = new Map<
    Pid,
    Array<{ facet: "proc" | "ports" | "mem" | "start_time"; errno: string }>
  >();
  for (const row of reading.unreadable) {
    const facts = unreadable.get(row.pid) ?? [];
    facts.push({ facet: row.facet, errno: row.errno });
    unreadable.set(row.pid, facts);
  }

  for (const row of reading.procs) {
    processes.set(row.pid, {
      command: row.name,
      ppid: row.ppid,
      rssBytes: memory.get(row.pid) ?? null,
      startedAtMs: starts.get(row.pid) ?? null,
      listeners: [],
      unreadable: unreadable.get(row.pid) ?? [],
    });
  }
  for (const row of reading.unreadable) {
    if (!processes.has(row.pid))
      processes.set(row.pid, {
        command: "",
        ppid: 0,
        rssBytes: memory.get(row.pid) ?? null,
        startedAtMs: starts.get(row.pid) ?? null,
        listeners: [],
        unreadable: unreadable.get(row.pid) ?? [],
      });
  }

  const unclaimedListeners = new Map<
    UnclaimedListenerId,
    UnclaimedListener
  >();
  for (const row of reading.ports) {
    if (row.status === "claimed") {
      const process = processes.get(row.pid);
      if (process)
        process.listeners.push({
          uid: row.uid ?? null,
          port: row.port,
          address: row.address,
        });
      continue;
    }
    const uid = row.uid ?? null;
    const key = `${uid ?? "-"}:${row.address}:${row.port}`;
    unclaimedListeners.set(key, { uid, port: row.port, address: row.address });
  }
  return { processes, unclaimedListeners };
}

interface HostBaseline {
  takenMs: number;
  cpus: Map<number, CpuCounters>;
  networks: Map<string, NetCounters>;
}

export function hostFromOsfacts(
  reading: OsfactsReading,
  previous: HostBaseline | undefined,
  takenMs: number,
  os: SystemInfo["os"],
  hostName: string,
): { frame: HostFrame; baseline: HostBaseline } {
  assertNoSourceErrors(reading, "host");
  const load = requireFact(reading.load, "load");
  const memory = requireFact(reading.hostMemory, "memory");
  const swap = requireFact(reading.swap, "swap");
  const uptimeUs = requireFact(reading.uptimeUs, "uptime");
  const disk = reading.disks.find(({ mount }) => mount === "/");
  if (!disk) throw new Error("osfacts host response omitted root disk fact");

  const cpus = new Map<number, CpuCounters>(
    reading.cpus.map(({ core, userUs, systemUs, idleUs, otherUs }) => [
      core,
      { userUs, systemUs, idleUs, otherUs },
    ]),
  );
  const networks = new Map<string, NetCounters>(
    reading.networks.map(({ name, rxBytes, txBytes }) => [
      name,
      { rxBytes, txBytes },
    ]),
  );
  const winSec = previous ? (takenMs - previous.takenMs) / 1000 : 0;
  const frame: HostFrame = {
    system: {
      loadAvg: [load.one, load.five, load.fifteen],
      memUsed: memory.totalBytes - memory.availableBytes,
      memTotal: memory.totalBytes,
      swapUsed: swap.usedBytes,
      swapTotal: swap.totalBytes,
      diskUsed: disk.totalBytes - disk.availableBytes,
      diskTotal: disk.totalBytes,
      uptime: uptimeUs / 1_000_000,
      os,
      hostname: hostName,
    },
    cpuCores: computeCpuUsage(previous?.cpus ?? new Map(), cpus),
    networkInterfaces: computeNetThroughput(
      previous?.networks ?? new Map(),
      networks,
      winSec,
    ),
  };
  return { frame, baseline: { takenMs, cpus, networks } };
}

export type SnapshotSubtree = typeof snapshotSubtree;
export type ReadHost = typeof readOsfactsHost;

/** One osfacts subprocess per fact family per cache window. The independently
 * polled surface collections share the same atomic V2 reading rather than
 * racing three host subprocesses and computing rates from mismatched frames. */
export function createOsfactsReader(
  bin: string,
  os: SystemInfo["os"],
  hostName: string,
  readSnapshot: SnapshotSubtree = snapshotSubtree,
  readHost: ReadHost = readOsfactsHost,
  now: () => number = Date.now,
): ProcReader {
  const maxAgeMs = 1_000;
  let processCache:
    | { takenMs: number; promise: Promise<ProcessFrame> }
    | undefined;
  let hostCache: { takenMs: number; promise: Promise<HostFrame> } | undefined;
  let hostBaseline: HostBaseline | undefined;

  const processFrame = (): Promise<ProcessFrame> => {
    const takenMs = now();
    if (processCache && takenMs - processCache.takenMs < maxAgeMs)
      return processCache.promise;
    const promise = readSnapshot(bin, [1], {
      procs: true,
      ports: true,
      mem: true,
      startTime: true,
    }).then(processesFromOsfacts);
    processCache = { takenMs, promise };
    return promise;
  };

  const hostFrame = (): Promise<HostFrame> => {
    const takenMs = now();
    if (hostCache && takenMs - hostCache.takenMs < maxAgeMs)
      return hostCache.promise;
    const promise = readHost(bin, {
      load: true,
      mem: true,
      cpu: true,
      net: true,
      disk: true,
    }).then((reading) => {
      const mapped = hostFromOsfacts(
        reading,
        hostBaseline,
        takenMs,
        os,
        hostName,
      );
      hostBaseline = mapped.baseline;
      return mapped.frame;
    });
    hostCache = { takenMs, promise };
    return promise;
  };

  return {
    os,
    readSystem: async () => (await hostFrame()).system,
    readProcesses: async () => (await processFrame()).processes,
    readUnclaimedListeners: async () =>
      (await processFrame()).unclaimedListeners,
    readCpuCores: async () => (await hostFrame()).cpuCores,
    readNetwork: async () => (await hostFrame()).networkInterfaces,
  };
}

export function osfactsBinPath(): string {
  const bin = process.env.DRISHTI_OSFACTS_BIN;
  if (!bin)
    throw new Error(
      "DRISHTI_OSFACTS_BIN is not set — run the Nix-wrapped drishti-agent (no PATH fallback)",
    );
  return bin;
}

export function createProcReader(): ProcReader {
  const raw = platform();
  const os: SystemInfo["os"] =
    raw === "linux" ? "linux" : raw === "darwin" ? "darwin" : "unknown";
  if (os === "unknown")
    throw new Error(`osfacts is unsupported on platform ${raw}`);
  return createOsfactsReader(osfactsBinPath(), os, hostname());
}
