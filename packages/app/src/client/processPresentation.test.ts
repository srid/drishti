import { describe, expect, it } from "bun:test";
import type { Process } from "drishti-common";
import {
  DEFAULT_PROCESS_SORT_KEY,
  processComparator,
  processDetailMemoryText,
  processMatches,
  processRowUptime,
  PROCESS_SORT_KEYS,
  processStateText,
  processTableCell,
} from "./processPresentation";

const process = (unreadable: Process["unreadable"]): Process => ({
  name: "server",
  command: "server --listen 8080",
  cpuPct: 0,
  user: "root",
  cwd: null,
  state: null,
  nice: null,
  threads: null,
  ppid: 1,
  rssBytes: null,
  startedAtMs: null,
  listeners: [],
  unreadable,
});

describe("process table qualified cells", () => {
  it("renders a ports-blind errno in the PORTS cell instead of the empty dash", () => {
    expect(
      processTableCell(
        process([{ facet: "ports", errno: "EACCES" }]),
        "ports",
        "—",
      ),
    ).toEqual({ text: "EACCES", warning: true });
  });

  it("keeps the dash for a readable process with no listeners", () => {
    expect(processTableCell(process([]), "ports", "—")).toEqual({
      text: "—",
      warning: false,
    });
  });
});

describe("process detail presentation", () => {
  it("renders resident memory as bytes and a percentage of host memory", () => {
    expect(processDetailMemoryText(4_000_000_000, 16_000_000_000)).toBe(
      "4.0 GB · 25.0%",
    );
  });

  it("reprojects a remote process start through the host clock lens", () => {
    expect(
      processRowUptime(3_605_000, 7_200_000, (remoteMs) => remoteMs - 5_000),
    ).toBe("1h 0m");
  });

  it("restores human process-state labels", () => {
    expect(processStateText("R")).toBe("running (R)");
    expect(processStateText(null)).toBe("—");
  });
});

describe("restored process sorting and search", () => {
  it("accepts legacy cpu/user preferences and defaults to CPU", () => {
    expect(PROCESS_SORT_KEYS).toContain("cpu");
    expect(PROCESS_SORT_KEYS).toContain("user");
    expect(DEFAULT_PROCESS_SORT_KEY).toBe("cpu");
  });

  it("sorts CPU descending and user ascending", () => {
    const procs = {
      1: { ...process([]), cpuPct: 2, user: "root" },
      2: { ...process([]), cpuPct: 40, user: "1000" },
    };
    expect([1, 2].sort(processComparator("cpu", procs))).toEqual([2, 1]);
    expect([1, 2].sort(processComparator("user", procs))).toEqual([2, 1]);
  });

  it("searches uid presentation, cwd, and full argv", () => {
    const restored = {
      ...process([]),
      user: "1000",
      cwd: "/srv/drishti",
      command: "/usr/bin/bun --inspect=9229",
    };
    expect(processMatches(42, restored, "1000")).toBe(true);
    expect(processMatches(42, restored, "drishti")).toBe(true);
    expect(processMatches(42, restored, "inspect=9229")).toBe(true);
  });
});
