import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pid } from "drishti-common";
import type { ProcessUsage } from "./processUsageFallback";

export const DARWIN_PS_PATH = "/bin/ps";
export const DARWIN_PS_ARGS = ["-axo", "pid=,pcpu=,rss="] as const;

export interface DarwinPsOptions {
  timeout: number;
  killSignal: NodeJS.Signals;
  maxBuffer: number;
}

const DARWIN_PS_OPTIONS: DarwinPsOptions = {
  // Preserve the pre-osfacts reader's proven child discipline: a hung ps must
  // settle so the poll's single-flight guard can release, while large process
  // tables must not trip Node's small default output buffer.
  timeout: 20_000,
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
