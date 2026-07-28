import type { Pid, Process, SourceErrorFact } from "drishti-common";

/** The two facts Apple's privileged ps can recover when task inspection is
 * denied to the ordinary osfacts process. This source-owned shape contains no
 * process identity or presentation policy. */
export interface ProcessUsage {
  cpuPct: number;
  rssBytes: number;
}

/** Acquisition provenance supplied by the source boundary. The recovery
 * policy stays command-agnostic; `/bin/ps` is only one possible producer. */
export interface CommandFallback {
  command: string;
}

/** Fill only facts osfacts explicitly marked unreadable. Readable osfacts
 * values always win, an absent ps row stays honestly blind, and input rows are
 * never mutated. */
export function recoverUnreadableProcessUsage(
  processes: ReadonlyMap<Pid, Process>,
  fallback: ReadonlyMap<Pid, ProcessUsage>,
  sourceErrors: readonly SourceErrorFact[],
  source: CommandFallback,
): Map<Pid, Process> {
  const sourceBlind = new Set(
    sourceErrors
      .filter(
        ({ operation, facet }) =>
          operation === "snapshot" &&
          (facet === "cpu_time" || facet === "mem"),
      )
      .map(({ facet }) => facet),
  );
  const recovered = new Map<Pid, Process>();
  for (const [pid, process] of processes) {
    const usage = fallback.get(pid);
    const cpuBlind =
      sourceBlind.has("cpu_time") ||
      process.unreadable.some(({ facet }) => facet === "cpu_time");
    const memoryBlind =
      sourceBlind.has("mem") ||
      process.unreadable.some(({ facet }) => facet === "mem");
    if (usage === undefined || (!cpuBlind && !memoryBlind)) {
      recovered.set(pid, process);
      continue;
    }
    recovered.set(pid, {
      ...process,
      cpuPct: cpuBlind ? usage.cpuPct : process.cpuPct,
      rssBytes: memoryBlind ? usage.rssBytes : process.rssBytes,
      fallbacks: [
        ...process.fallbacks,
        ...(cpuBlind
          ? [{ facet: "cpu_time" as const, command: source.command }]
          : []),
        ...(memoryBlind
          ? [{ facet: "mem" as const, command: source.command }]
          : []),
      ],
      unreadable: process.unreadable.filter(
        ({ facet }) =>
          !(cpuBlind && facet === "cpu_time") &&
          !(memoryBlind && facet === "mem"),
      ),
    });
  }
  return recovered;
}
