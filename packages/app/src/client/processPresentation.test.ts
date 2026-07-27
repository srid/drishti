import { describe, expect, it } from "bun:test";
import type { Process } from "drishti-common";
import { processTableCell } from "./processPresentation";

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
