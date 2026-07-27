import { formatListenerAddress, type Pid, type Process } from "drishti-common";
import { formatBytes, formatProcessUptime, pctOf } from "./metrics";

export type ProcessTableFacet =
  | "proc"
  | "ports"
  | "mem"
  | "start_time"
  | "cpu_time"
  | "uid"
  | "cwd"
  | "status"
  | "argv";

export const PROCESS_SORT_KEYS = [
  "cpu",
  "user",
  "pid",
  "ppid",
  "mem",
  "uptime",
  "ports",
  "command",
] as const;
export type ProcessSortKey = (typeof PROCESS_SORT_KEYS)[number];
export const DEFAULT_PROCESS_SORT_KEY: ProcessSortKey = "cpu";

export function processMatches(pid: Pid, process: Process, query: string): boolean {
  const q = query.trim().toLowerCase();
  return (
    q.length === 0 ||
    String(pid).includes(q) ||
    process.user.toLowerCase().includes(q) ||
    process.command.toLowerCase().includes(q) ||
    (process.cwd?.toLowerCase().includes(q) ?? false) ||
    process.listeners.some((listener) =>
      formatListenerAddress(listener.address, listener.port)
        .toLowerCase()
        .includes(q),
    ) ||
    process.unreadable.some(
      ({ facet, errno }) =>
        facet.includes(q) || errno.toLowerCase().includes(q),
    )
  );
}

export function processComparator(
  key: ProcessSortKey,
  procs: Record<Pid, Process>,
): (a: Pid, b: Pid) => number {
  if (key === "ppid")
    return (a, b) => procs[a]!.ppid - procs[b]!.ppid || a - b;
  if (key === "ports")
    return (a, b) =>
      procs[b]!.listeners.length - procs[a]!.listeners.length || a - b;
  if (key === "mem")
    return (a, b) =>
      (procs[b]!.rssBytes ?? -1) - (procs[a]!.rssBytes ?? -1) || a - b;
  if (key === "uptime")
    return (a, b) =>
      (procs[a]!.startedAtMs ?? Number.POSITIVE_INFINITY) -
        (procs[b]!.startedAtMs ?? Number.POSITIVE_INFINITY) || a - b;
  if (key === "command")
    return (a, b) =>
      procs[a]!.command.localeCompare(procs[b]!.command) || a - b;
  if (key === "user")
    return (a, b) => procs[a]!.user.localeCompare(procs[b]!.user) || a - b;
  if (key === "cpu")
    return (a, b) => procs[b]!.cpuPct - procs[a]!.cpuPct || a - b;
  return (a, b) => a - b;
}

const PROCESS_STATE_LABELS: Record<string, string> = {
  R: "running",
  S: "sleeping",
  D: "uninterruptible",
  Z: "zombie",
  T: "stopped",
  t: "tracing stop",
  I: "idle",
  X: "dead",
  W: "paging",
};

export function processStateText(state: string | null): string {
  if (state === null) return "—";
  const label = PROCESS_STATE_LABELS[state];
  return label === undefined ? state : `${label} (${state})`;
}

/** Resolve a table cell at the facet it presents. Blindness replaces the
 * readable/empty value at that exact point, so `—` has only one meaning:
 * the facet was readable and observed no value. */
export function processTableCell(
  process: Process,
  facet: ProcessTableFacet,
  readableText: string,
): { text: string; warning: boolean } {
  const blind = process.unreadable.find((fact) => fact.facet === facet);
  return blind === undefined
    ? { text: readableText, warning: false }
    : { text: blind.errno, warning: true };
}

/** Render a process's resident set in the detail pane with its share of the
 * host's retained total-memory fact. Null remains honestly unavailable. */
export function processDetailMemoryText(
  rssBytes: number | null,
  memTotal: number,
): string {
  return rssBytes === null
    ? "—"
    : `${formatBytes(rssBytes)} · ${pctOf(rssBytes, memTotal).toFixed(1)}%`;
}

/** Present a remote process start against the browser clock only after the
 * host-map lens has reprojected its epoch into local time. */
export function processRowUptime(
  remoteStartedAtMs: number | null | undefined,
  nowMs: number,
  toLocalTime: (remoteMs: number) => number | null,
): string {
  return formatProcessUptime(remoteStartedAtMs, nowMs, toLocalTime);
}
