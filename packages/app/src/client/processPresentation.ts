import type { Process } from "drishti-common";

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
