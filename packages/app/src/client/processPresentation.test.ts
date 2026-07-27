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
  processTableRowPresentation,
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

const fullyBlind = (): Process =>
  process([
    { facet: "proc", errno: "EPERM" },
    { facet: "ports", errno: "EPERM" },
    { facet: "mem", errno: "EPERM" },
    { facet: "start_time", errno: "EPERM" },
    { facet: "cpu_time", errno: "EPERM" },
    { facet: "uid", errno: "EPERM" },
    { facet: "cwd", errno: "EPERM" },
    { facet: "status", errno: "EPERM" },
    { facet: "argv", errno: "EPERM" },
  ]);

describe("process table qualified cells", () => {
  it("collapses a fully-blind row to one dimmed unreadable label", () => {
    const rendered = processTableRowPresentation(42, fullyBlind(), "—");

    expect(rendered.dimmed).toBe(true);
    expect(rendered.cells.command.text).toBe("unreadable · EPERM");
    expect(rendered.commandSecondary).toBeNull();
    expect(
      Object.values(rendered.cells).filter(({ text }) => text.includes("EPERM")),
    ).toHaveLength(1);
    expect(
      Object.entries(rendered.cells)
        .filter(([name]) => name !== "command")
        .every(([, cell]) => cell.text === "—" && !cell.warning),
    ).toBe(true);
  });

  it("keeps per-cell errno markers for a partially-blind row", () => {
    const rendered = processTableRowPresentation(
      42,
      process([{ facet: "ports", errno: "EACCES" }]),
      "1m",
    );

    expect(rendered.dimmed).toBe(false);
    expect(rendered.cells.ports).toEqual({ text: "EACCES", warning: true });
    expect(rendered.cells.command).toEqual({ text: "server", warning: false });
  });

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

  it("sorts fully-blind rows below readable zero-CPU rows", () => {
    const procs = {
      1: fullyBlind(),
      2: process([]),
    };

    expect([1, 2].sort(processComparator("cpu", procs))).toEqual([2, 1]);
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

  it("finds fully-blind rows by errno", () => {
    expect(processMatches(42, fullyBlind(), "eperm")).toBe(true);
  });
});
