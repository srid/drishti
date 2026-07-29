import { describe, expect, it } from "bun:test";
import type { Process } from "drishti-common";
import { recoverUnreadableProcessUsage } from "./processUsageFallback";

const process = (overrides: Partial<Process> = {}): Process => ({
  name: "server",
  command: "server",
  cpuPct: 0,
  user: "502",
  cwd: "/tmp",
  state: "S",
  nice: 0,
  threads: null,
  ppid: 1,
  rssBytes: null,
  startedAtMs: 1,
  listeners: [],
  fallbacks: [],
  unreadable: [],
  ...overrides,
});

describe("process usage fallback policy", () => {
  it("fills only unreadable CPU/RSS facets and clears only recovered markers", () => {
    const original = process({
      unreadable: [
        { facet: "cpu_time", errno: "EACCES" },
        { facet: "mem", errno: "EACCES" },
        { facet: "cwd", errno: "EPERM" },
      ],
    });
    const recovered = recoverUnreadableProcessUsage(
      new Map([[42, original]]),
      new Map([[42, { cpuPct: 17.5, rssBytes: 4_194_304 }]]),
      [],
      "/bin/ps",
    ).get(42)!;

    expect(recovered).toEqual({
      ...original,
      cpuPct: 17.5,
      rssBytes: 4_194_304,
      fallbacks: [
        { facet: "cpu_time", command: "/bin/ps" },
        { facet: "mem", command: "/bin/ps" },
      ],
      unreadable: [{ facet: "cwd", errno: "EPERM" }],
    });
    expect(original.cpuPct).toBe(0);
    expect(original.rssBytes).toBeNull();
    expect(original.unreadable).toHaveLength(3);
  });

  it("never overwrites readable osfacts values", () => {
    const original = process({ cpuPct: 8, rssBytes: 2048 });
    const recovered = recoverUnreadableProcessUsage(
      new Map([[42, original]]),
      new Map([[42, { cpuPct: 99, rssBytes: 99_999 }]]),
      [],
      "/bin/ps",
    );

    expect(recovered.get(42)).toBe(original);
  });

  it("recovers a whole osfacts source failure even without per-pid markers", () => {
    const original = process();
    const recovered = recoverUnreadableProcessUsage(
      new Map([[42, original]]),
      new Map([[42, { cpuPct: 7.5, rssBytes: 65_536 }]]),
      [
        {
          operation: "snapshot",
          source: "task_info",
          facet: "cpu_time",
          code: "EACCES",
        },
        {
          operation: "snapshot",
          source: "task_info",
          facet: "mem",
          code: "EACCES",
        },
      ],
      "/bin/ps",
    ).get(42)!;

    expect(recovered.cpuPct).toBe(7.5);
    expect(recovered.rssBytes).toBe(65_536);
    expect(recovered.fallbacks).toEqual([
      { facet: "cpu_time", command: "/bin/ps" },
      { facet: "mem", command: "/bin/ps" },
    ]);
  });

  it("leaves blind facts honest when ps has no matching pid", () => {
    const original = process({
      unreadable: [
        { facet: "cpu_time", errno: "EACCES" },
        { facet: "mem", errno: "EACCES" },
      ],
    });
    const recovered = recoverUnreadableProcessUsage(
      new Map([[42, original]]),
      new Map([[7, { cpuPct: 9, rssBytes: 1024 }]]),
      [],
      "/bin/ps",
    );

    expect(recovered.get(42)).toBe(original);
  });

  it("synthesizes unreadable markers when a source E has no ps row", () => {
    const original = process();
    const recovered = recoverUnreadableProcessUsage(
      new Map([[42, original]]),
      new Map(),
      [
        {
          operation: "snapshot",
          source: "task_info",
          facet: "cpu_time",
          code: "EACCES",
        },
        {
          operation: "snapshot",
          source: "task_info",
          facet: "mem",
          code: "EACCES",
        },
      ],
      "/bin/ps",
    ).get(42)!;

    expect(recovered.cpuPct).toBe(0);
    expect(recovered.rssBytes).toBeNull();
    expect(recovered.fallbacks).toEqual([]);
    expect(recovered.unreadable).toEqual([
      { facet: "cpu_time", errno: "EACCES" },
      { facet: "mem", errno: "EACCES" },
    ]);
  });

  it("does not overwrite a present RSS under a source mem E", () => {
    const original = process({ rssBytes: 4096, cpuPct: 3 });
    const recovered = recoverUnreadableProcessUsage(
      new Map([[42, original]]),
      new Map([[42, { cpuPct: 99, rssBytes: 99_999 }]]),
      [
        {
          operation: "snapshot",
          source: "task_info",
          facet: "mem",
          code: "EACCES",
        },
      ],
      "/bin/ps",
    );

    expect(recovered.get(42)).toBe(original);
  });
});
