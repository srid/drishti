import { describe, expect, it } from "bun:test";
import { surface } from "./surface";

// drishti is an observe-mostly monitor: the per-host surface is cells,
// collections, and streams plus EXACTLY ONE deliberate mutating escape hatch —
// the `process.kill` procedure (the R7 keystone, kolu #1505). A procedure is the
// only way to push a mutation down to a monitored host, so this test pins the
// blast radius: `process.kill` is the sole procedure, and ANY other procedure
// (or a second verb under `process`) fails on purpose — a new way to act on a
// host must be a deliberate decision, not an oversight quietly slipped in.
describe("surface mutation surface is exactly process.kill", () => {
  it("declares exactly the `process.kill` escape hatch and no other procedure", () => {
    const procedures = (surface.spec.procedures ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    // Exactly one namespace (`process`), exactly one verb under it (`kill`).
    expect(Object.keys(procedures)).toEqual(["process"]);
    expect(Object.keys(procedures.process ?? {})).toEqual(["kill"]);
  });

  it("still exposes the read-only primitives", () => {
    expect(Object.keys(surface.spec.cells ?? {})).toContain("system");
    expect(Object.keys(surface.spec.collections ?? {})).toContain("processes");
    expect(Object.keys(surface.spec.streams ?? {})).toContain(
      "processesSnapshot",
    );
  });
});
