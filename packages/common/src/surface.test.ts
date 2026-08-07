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
  });

  it("serves the whole process set as the `processes` `deltas` collection, not a separate stream (SR5)", () => {
    // One protocol across the wire: the `processes` collection declares the `deltas`
    // verb (the framework serves one coalesced snapshot-then-delta stream), replacing
    // the hand-rolled `processesSnapshot` stream. `metricHistory` is the durable
    // agent-owned ring stream (UW3) — the only stream on this surface.
    const processes = surface.spec.collections?.processes as
      | { verbs?: readonly string[] }
      | undefined;
    expect(processes?.verbs).toContain("deltas");
    const streams =
      (surface.spec as { streams?: Record<string, unknown> }).streams ?? {};
    expect(Object.keys(streams)).not.toContain("processesSnapshot");
    expect(Object.keys(streams)).toContain("metricHistory");
  });
});

// The agent daemon serves a SECOND drishti-owned surface beside this one — the
// `daemon` sibling carrying `ring.drain` (see `./daemon`). It is deliberately
// NOT a member of the surface above, because this surface is re-served verbatim
// to the browser: a drain verb here would hand every tab the authority to stop
// any host's daemon. That separation is the whole design, so it gets a pin.
describe("the daemon control sibling is NOT on the mirrored surface", () => {
  it("keeps `ring.drain` off the surface the browser sees", async () => {
    const { daemonControlSurface } = await import("./daemon");
    expect([...daemonControlSurface.group.requests.keys()]).toContain(
      "surface/ring/drain",
    );
    // Standalone tags above; MOUNTED as the `daemon` sibling on the wire.
    expect([...surface.group.requests.keys()]).not.toContain(
      "surface/ring/drain",
    );
    const { browserSurface } = await import("./browser");
    expect(Object.keys(browserSurface.spec.procedures ?? {})).toEqual([
      "process",
    ]);
  });

  it("mounts it at `surface/daemon/ring/drain`, disjoint from the app sibling", async () => {
    const { agentDaemonComposed } = await import("./daemon");
    const tags = [...agentDaemonComposed.group.requests.keys()];
    expect(tags).toContain("surface/daemon/ring/drain");
    expect(tags).toContain("surface/control/core/drain");
    expect(tags).toContain("surface/app/process/kill");
    // The merge dropped nothing: three siblings, no colliding tag.
    expect(new Set(tags).size).toBe(tags.length);
  });
});
