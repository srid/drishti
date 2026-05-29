import { describe, expect, it } from "bun:test";
import { surface } from "./surface";

// drishti is a read-only monitor: the per-host surface must expose
// cells, collections, and streams but **no procedures**. A procedure is
// the only way to push a mutation (e.g. a signal/kill) down to the
// monitored host, so the absence of any procedure is the structural
// guarantee that the app can't act on a host — only observe it. If a
// future change re-introduces a procedure here, this test fails on
// purpose: removing the kill capability was a deliberate decision, not
// an oversight to be quietly undone.
describe("surface is read-only", () => {
  it("declares no procedures", () => {
    // The spec type literally has no `procedures` key (read-only by
    // construction). Widen to read the optional slot at runtime: this
    // still fails the moment a procedure is re-added, even though the
    // type would also light up at the call sites that consume it.
    const spec = surface.spec as Record<string, unknown>;
    expect(spec.procedures).toBeUndefined();
  });

  it("still exposes the read-only primitives", () => {
    expect(Object.keys(surface.spec.cells ?? {})).toContain("system");
    expect(Object.keys(surface.spec.collections ?? {})).toContain("processes");
    expect(Object.keys(surface.spec.streams ?? {})).toContain(
      "processesSnapshot",
    );
  });
});
