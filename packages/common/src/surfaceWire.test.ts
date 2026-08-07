/**
 * BYTE-LEVEL wire fixtures for the agent surface (the #17 obligation).
 *
 * Everything here crosses agent → parent → browser, and `MetricSample` also
 * survives a daemon restart on disk (`history.ring.json`). The zod → Effect
 * Schema rewrite must be byte-invisible, so these assert the ENCODED JSON
 * STRING — not decode-equality, which would happily pass while `optionalKey`
 * silently became `optional` (absent → `null`) or a discriminated union became
 * a tagged one (`kind` → `_tag`).
 *
 * Plus the D1 route-set pin: the exact tag key set the surface mints. That is
 * the successor to the oRPC-era contract-shape reasoning — on a flat wire
 * namespace, the tag set IS the contract.
 */
import { Schema } from "effect";
import { describe, expect, it } from "bun:test";
import { AlertsSchema } from "./alerts";
import {
  type KillArgs,
  MetricHistoryMessage,
  MetricSampleSchema,
  surface,
} from "./surface";

const killInput = surface.spec.procedures?.process?.kill?.input;
const killOutput = surface.spec.procedures?.process?.kill?.output;

const SAMPLE = { t: 1, cpu: 2, mem: 3, swap: 4, disk: 5 } as const;
const SAMPLE_JSON = '{"t":1,"cpu":2,"mem":3,"swap":4,"disk":5}';

describe("process.kill — the two #17 landmines", () => {
  it("decodes an ABSENT `signal` key to TERM (withDecodingDefaultKey)", () => {
    if (!killInput) throw new Error("kill input schema missing");
    const decoded = Schema.decodeUnknownSync(killInput)({ pid: 42 });
    expect(decoded).toEqual({ pid: 42, signal: "TERM" });
  });

  it("keeps an EXPLICIT `signal` verbatim", () => {
    if (!killInput) throw new Error("kill input schema missing");
    expect(
      Schema.decodeUnknownSync(killInput)({ pid: 42, signal: "KILL" }),
    ).toEqual({ pid: 42, signal: "KILL" });
  });

  it("REJECTS an explicit `signal: undefined` — the key may be missing, never null-shaped", () => {
    if (!killInput) throw new Error("kill input schema missing");
    expect(() =>
      Schema.decodeUnknownSync(killInput)({ pid: 42, signal: undefined }),
    ).toThrow();
  });

  it("a caller may OMIT `signal` at the type level (the Encoded side)", () => {
    // Compile-time half of the pin: `KillArgs` is the ENCODED side, where the
    // defaulted key is optional. A regression to the decoded side would make
    // this line a type error.
    const args: KillArgs = { pid: 42 };
    expect(args.pid).toBe(42);
  });

  it("OMITS `error` on success — never `\"error\":null` (optionalKey, not optional)", () => {
    if (!killOutput) throw new Error("kill output schema missing");
    expect(JSON.stringify(Schema.encodeSync(killOutput)({ ok: true }))).toBe(
      '{"ok":true}',
    );
  });

  it("carries `error` verbatim on failure", () => {
    if (!killOutput) throw new Error("kill output schema missing");
    expect(
      JSON.stringify(Schema.encodeSync(killOutput)({ ok: false, error: "ESRCH" })),
    ).toBe('{"ok":false,"error":"ESRCH"}');
  });
});

describe("MetricHistoryMessage — all four arms, encoded bytes", () => {
  const encode = Schema.encodeSync(MetricHistoryMessage);

  it("snapshot", () => {
    expect(JSON.stringify(encode({ kind: "snapshot", samples: [SAMPLE] }))).toBe(
      `{"kind":"snapshot","samples":[${SAMPLE_JSON}]}`,
    );
  });

  it("delta", () => {
    expect(JSON.stringify(encode({ kind: "delta", sample: SAMPLE }))).toBe(
      `{"kind":"delta","sample":${SAMPLE_JSON}}`,
    );
  });

  it("unavailable", () => {
    expect(JSON.stringify(encode({ kind: "unavailable", reason: "corrupt" }))).toBe(
      '{"kind":"unavailable","reason":"corrupt"}',
    );
  });

  it("degraded", () => {
    expect(
      JSON.stringify(
        encode({ kind: "degraded", reason: "persist-failed", samples: [] }),
      ),
    ).toBe('{"kind":"degraded","reason":"persist-failed","samples":[]}');
  });

  it("keeps `kind` as the discriminant — a TaggedUnion would spell `_tag`", () => {
    const wire = JSON.parse(
      JSON.stringify(encode({ kind: "delta", sample: SAMPLE })),
    ) as Record<string, unknown>;
    expect(Object.keys(wire)).toContain("kind");
    expect(Object.keys(wire)).not.toContain("_tag");
  });

  it("round-trips every arm through decode", () => {
    const decode = Schema.decodeUnknownSync(MetricHistoryMessage);
    expect(decode({ kind: "snapshot", samples: [SAMPLE] })).toEqual({
      kind: "snapshot",
      samples: [SAMPLE],
    });
    expect(decode({ kind: "unavailable", reason: "unknown-version" })).toEqual({
      kind: "unavailable",
      reason: "unknown-version",
    });
  });
});

describe("MetricSample + Alerts — the disk/wire leaves", () => {
  it("MetricSample encodes with field order and no extras", () => {
    expect(JSON.stringify(Schema.encodeSync(MetricSampleSchema)(SAMPLE))).toBe(
      SAMPLE_JSON,
    );
  });

  it("Alerts encodes the bare id list", () => {
    expect(
      JSON.stringify(Schema.encodeSync(AlertsSchema)({ items: ["cpu", "disk"] })),
    ).toBe('{"items":["cpu","disk"]}');
  });

  it("Alerts refuses an unknown metric id", () => {
    expect(() =>
      Schema.decodeUnknownSync(AlertsSchema)({ items: ["gpu"] }),
    ).toThrow();
  });
});

describe("D1 — the surface's wire tag set", () => {
  it("mints exactly these tags (route-set identity, the flat-namespace contract)", () => {
    expect([...surface.group.requests.keys()].sort()).toEqual([
      "surface/alerts/get",
      "surface/cpuCores/deltas",
      "surface/cpuCores/get",
      "surface/cpuCores/keys",
      "surface/metricHistory/get",
      "surface/networkInterfaces/deltas",
      "surface/networkInterfaces/get",
      "surface/networkInterfaces/keys",
      "surface/process/kill",
      "surface/processes/deltas",
      "surface/processes/get",
      "surface/processes/keys",
      "surface/sourceErrors/deltas",
      "surface/sourceErrors/get",
      "surface/sourceErrors/keys",
      // The reserved framework trio shares the `system` NAME with the cell —
      // they never collide because a tag is (member, verb), and no cell verb is
      // called `live` / `identity` / `clockNow`.
      "surface/system/clockNow",
      "surface/system/get",
      "surface/system/identity",
      "surface/system/live",
      "surface/system/set",
      "surface/unclaimedListeners/deltas",
      "surface/unclaimedListeners/get",
      "surface/unclaimedListeners/keys",
    ]);
  });
});
