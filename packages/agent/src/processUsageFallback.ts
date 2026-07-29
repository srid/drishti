import type { Pid, Process, SourceErrorFact } from "drishti-common";
import type { ProcessUsage } from "./darwinPs";

/** Fill only facts osfacts marked unreadable — per-pid `U` rows, or a
 * whole-source snapshot `E` for `cpu_time`/`mem` when the process still lacks
 * an authoritative value for that facet. Readable osfacts values always win.
 * An absent usage row stays honestly blind (synthesizing a `U` marker when
 * only the source-level `E` said so). Input rows are never mutated. */
export function recoverUnreadableProcessUsage(
  processes: ReadonlyMap<Pid, Process>,
  fallback: ReadonlyMap<Pid, ProcessUsage>,
  sourceErrors: readonly SourceErrorFact[],
  command: string,
): Map<Pid, Process> {
  // Whole-source E rows mean the facet failed for the census, not one pid.
  // Map facet → errno so a missing usage row can stay honestly blind.
  const sourceBlind = new Map<string, string>();
  for (const { operation, facet, code } of sourceErrors) {
    if (
      operation === "snapshot" &&
      (facet === "cpu_time" || facet === "mem")
    )
      sourceBlind.set(facet, code);
  }

  const recovered = new Map<Pid, Process>();
  for (const [pid, process] of processes) {
    const hasCpuU = process.unreadable.some(
      ({ facet }) => facet === "cpu_time",
    );
    const hasMemU = process.unreadable.some(({ facet }) => facet === "mem");
    // Per-pid U always qualifies. Source-level E qualifies only when the
    // process still lacks an authoritative value — otherwise partial rows
    // under a source E would be overwritten contrary to "osfacts wins".
    // Under a full cpu_time source failure there are no C rows, so cpuPct
    // stays 0 from the delta map (missing, not idle).
    const cpuEligible =
      hasCpuU || (sourceBlind.has("cpu_time") && process.cpuPct === 0);
    const memEligible =
      hasMemU || (sourceBlind.has("mem") && process.rssBytes === null);

    if (!cpuEligible && !memEligible) {
      recovered.set(pid, process);
      continue;
    }

    const usage = fallback.get(pid);
    if (usage === undefined) {
      const unreadable = [...process.unreadable];
      if (!hasCpuU && cpuEligible)
        unreadable.push({
          facet: "cpu_time",
          errno: sourceBlind.get("cpu_time") ?? "UNAVAILABLE",
        });
      if (!hasMemU && memEligible)
        unreadable.push({
          facet: "mem",
          errno: sourceBlind.get("mem") ?? "UNAVAILABLE",
        });
      recovered.set(
        pid,
        unreadable.length === process.unreadable.length
          ? process
          : { ...process, unreadable },
      );
      continue;
    }

    recovered.set(pid, {
      ...process,
      cpuPct: cpuEligible ? usage.cpuPct : process.cpuPct,
      rssBytes: memEligible ? usage.rssBytes : process.rssBytes,
      fallbacks: [
        ...process.fallbacks,
        ...(cpuEligible ? [{ facet: "cpu_time" as const, command }] : []),
        ...(memEligible ? [{ facet: "mem" as const, command }] : []),
      ],
      unreadable: process.unreadable.filter(
        ({ facet }) =>
          !(cpuEligible && facet === "cpu_time") &&
          !(memEligible && facet === "mem"),
      ),
    });
  }
  return recovered;
}
