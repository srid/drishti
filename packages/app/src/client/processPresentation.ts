import type { Process } from "drishti-common";
import { formatBytes, formatProcessUptime, pctOf } from "./metrics";

export type ProcessTableFacet = "proc" | "ports" | "mem" | "start_time";

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
