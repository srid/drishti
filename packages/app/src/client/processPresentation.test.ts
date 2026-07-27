import { describe, expect, it } from "bun:test";
import type { Process } from "drishti-common";
import {
  processDetailMemoryText,
  processRowUptime,
  processTableCell,
} from "./processPresentation";

const process = (unreadable: Process["unreadable"]): Process => ({
  command: "server",
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
});
