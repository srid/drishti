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
  | "status_threads"
  | "argv";

const PUBLISHED_PROCESS_FACETS: readonly ProcessTableFacet[] = [
  "proc",
  "ports",
  "mem",
  "start_time",
  "cpu_time",
  "uid",
  "cwd",
  "status",
  "argv",
];

/** One cell's qualification: native text, unreadable errno, or command-recovered
 * value. Illegal combinations (warning + fallback) are unrepresentable. */
export type ProcessTableCellPresentation =
  | { kind: "plain"; text: string }
  | { kind: "unreadable"; text: string }
  | { kind: "fallback"; text: string; command: string };

export interface TableMarker {
  glyph: "⊘" | "↩";
  title: string;
  ariaLabel: string;
}

/** Compact table rows keep errno detail behind one quiet, discoverable mark.
 * Details and search continue to use the original errno text. */
export function unreadableTableMarker(errno: string): TableMarker {
  return {
    glyph: "⊘",
    title: errno,
    ariaLabel: `Unreadable: ${errno}`,
  };
}

/** A recovered value remains readable, while this quiet mark discloses that
 * an external command supplied it. */
export function fallbackTableMarker(command: string): TableMarker {
  return {
    glyph: "↩",
    title: `Command fallback: ${command}`,
    ariaLabel: `Value recovered using command fallback: ${command}`,
  };
}

export interface ProcessTableRowPresentation {
  dimmed: boolean;
  cells: Record<
    "pid" | "user" | "cpu" | "ppid" | "mem" | "uptime" | "ports" | "command",
    ProcessTableCellPresentation
  >;
  commandSecondary: ProcessTableCellPresentation | null;
}

/** A row is fully blind only when every requested/published process facet has
 * an explicit U fact. Partial blindness remains actionable at the cell level. */
export function fullyBlindErrno(process: Process): string | null {
  const byFacet = new Map(
    process.unreadable.map((fact) => [fact.facet, fact.errno]),
  );
  if (!PUBLISHED_PROCESS_FACETS.every((facet) => byFacet.has(facet))) return null;
  const errnos = [
    ...new Set(PUBLISHED_PROCESS_FACETS.map((facet) => byFacet.get(facet)!)),
  ];
  return errnos.join("/");
}

export const PROCESS_SORT_KEYS = [
  "cpu",
  "user",
  "pid",
  "ppid",
  "mem",
  "uptime",
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
    return (a, b) => {
      const aBlind = fullyBlindErrno(procs[a]!) !== null;
      const bBlind = fullyBlindErrno(procs[b]!) !== null;
      if (aBlind !== bBlind) return aBlind ? 1 : -1;
      return procs[b]!.cpuPct - procs[a]!.cpuPct || a - b;
    };
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
): ProcessTableCellPresentation {
  const blind = process.unreadable.find((fact) => fact.facet === facet);
  if (blind !== undefined) return { kind: "unreadable", text: blind.errno };
  const fallback = process.fallbacks.find((fact) => fact.facet === facet);
  return fallback === undefined
    ? { kind: "plain", text: readableText }
    : { kind: "fallback", text: readableText, command: fallback.command };
}

/** Thread count can be blind independently of state/nice. A broad status
 * failure still qualifies all three fields, while the narrower facet only
 * qualifies threads. */
export function processThreadCell(
  process: Process,
  readableText: string,
): ProcessTableCellPresentation {
  const facet = process.unreadable.some(
    (fact) => fact.facet === "status_threads",
  )
    ? "status_threads"
    : "status";
  return processTableCell(process, facet, readableText);
}

/** Cell presentation for the compact process row. A fully blind row has one
 * row-level label in COMMAND; all other cells become non-warning dashes. */
export function processRowCell(
  process: Process,
  facet: ProcessTableFacet,
  readableText: string,
): ProcessTableCellPresentation {
  const errno = fullyBlindErrno(process);
  if (errno !== null)
    return {
      kind: "plain",
      text: facet === "proc" ? `unreadable · ${errno}` : "—",
    };
  return processTableCell(process, facet, readableText);
}

/** Pure render model used by the row and its regression tests. */
export function processTableRowPresentation(
  pid: Pid,
  process: Process,
  uptime: string,
): ProcessTableRowPresentation {
  const errno = fullyBlindErrno(process);
  const plain = (text: string): ProcessTableCellPresentation => ({
    kind: "plain",
    text: errno === null ? text : "—",
  });
  return {
    dimmed: errno !== null,
    cells: {
      pid: plain(String(pid)),
      user: processRowCell(process, "uid", process.user || "—"),
      cpu: processRowCell(process, "cpu_time", `${process.cpuPct.toFixed(1)}%`),
      ppid: plain(String(process.ppid)),
      mem: processRowCell(
        process,
        "mem",
        process.rssBytes === null ? "—" : formatBytes(process.rssBytes),
      ),
      uptime: processRowCell(process, "start_time", uptime),
      ports: processRowCell(
        process,
        "ports",
        process.listeners.map((listener) => listener.port).join(", ") || "—",
      ),
      command: processRowCell(process, "proc", process.name || "(unreadable)"),
    },
    commandSecondary:
      errno === null
        ? processRowCell(process, "cwd", process.cwd ?? "—")
        : null,
  };
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

export interface ProcessInspectionNote {
  text: string;
  tone: "warn" | "quiet";
}

/** Process-level quality summary for the detail panel. Native means no
 * unreadable and no command-recovered facets — never claim "all readable"
 * when any fallback note exists. */
export function processInspectionNotes(
  process: Process,
): ProcessInspectionNote[] {
  return [
    ...process.unreadable.map(({ facet, errno }) => ({
      text: `${facet} blind (${errno})`,
      tone: "warn" as const,
    })),
    ...process.fallbacks.map(({ facet, command }) => ({
      text: `${facet} via ${command}`,
      tone: "quiet" as const,
    })),
  ];
}
