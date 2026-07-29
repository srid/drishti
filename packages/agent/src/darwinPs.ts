import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pid } from "drishti-common";

/** The two facts Apple's privileged ps can recover when task inspection is
 * denied to the ordinary osfacts process. Source-owned shape: no identity or
 * recovery policy. */
export interface ProcessUsage {
  cpuPct: number;
  rssBytes: number;
}

export const DARWIN_PS_PATH = "/bin/ps";
export const DARWIN_PS_ARGS = ["-axo", "pid=,pcpu=,rss="] as const;

export interface DarwinPsOptions {
  timeout: number;
  killSignal: NodeJS.Signals;
  maxBuffer: number;
}

const DARWIN_PS_OPTIONS: DarwinPsOptions = {
  // Enrichment rides beside osfacts in Promise.all, so a hung ps stalls the
  // whole process frame. Cap well under the agent poll interval (2s) so a
  // dead census fails fast and the authoritative osfacts frame still lands.
  timeout: 1_500,
  killSignal: "SIGKILL",
  maxBuffer: 16 * 1024 * 1024,
};

export type DarwinPsRunner = (
  path: string,
  args: readonly string[],
  options: DarwinPsOptions,
) => Promise<string>;

const execFileAsync = promisify(execFile);

const runDarwinPs: DarwinPsRunner = async (path, args, options) => {
  const { stdout } = await execFileAsync(path, [...args], {
    ...options,
    encoding: "utf8",
  });
  return stdout;
};

/** Parse headerless `ps -axo pid=,pcpu=,rss=` output. ps reports resident
 * memory in KiB; Drishti's process contract is bytes. Malformed/racing rows
 * are skipped rather than poisoning the whole poll. */
export function parseDarwinProcessUsage(
  stdout: string,
): Map<Pid, ProcessUsage> {
  const usage = new Map<Pid, ProcessUsage>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)$/);
    if (match === null) continue;
    const pid = Number(match[1]);
    const cpuPct = Number(match[2]);
    const rssKiB = Number(match[3]);
    if (
      !Number.isSafeInteger(pid) ||
      pid < 0 ||
      !Number.isFinite(cpuPct) ||
      cpuPct < 0 ||
      !Number.isSafeInteger(rssKiB) ||
      rssKiB < 0
    )
      continue;
    usage.set(pid, { cpuPct, rssBytes: rssKiB * 1024 });
  }
  return usage;
}

/** Acquire one native Darwin process-usage census, independently of the
 * recovery policy that decides which osfacts cells it may qualify. */
export async function readDarwinProcessUsage(
  run: DarwinPsRunner = runDarwinPs,
): Promise<Map<Pid, ProcessUsage>> {
  return parseDarwinProcessUsage(
    await run(DARWIN_PS_PATH, DARWIN_PS_ARGS, DARWIN_PS_OPTIONS),
  );
}
