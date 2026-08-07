/**
 * Serializable rate baselines for the durable history ring (W2.4).
 *
 * Process + host families live in the agent `proc` reader as Maps; on flush
 * they ride the ring file so a drain→successor does not show a zero-rate first
 * tick. Pure encode/decode — no I/O.
 *
 * ⚠ **DISK format — #17 law applies.** `process` and `host` are
 * `Schema.optionalKey`, never `Schema.optional`: a ring written by a daemon
 * that had no baselines yet OMITS the key, and `Schema.optional` would make a
 * successor round-trip that absence through `null` — a shape neither the
 * reader nor `NO_BASELINES` has an arm for.
 */

import { Schema } from "effect";

const CpuCountersWire = Schema.Struct({
  userUs: Schema.Number,
  systemUs: Schema.Number,
  idleUs: Schema.Number,
  otherUs: Schema.Number,
  model: Schema.String,
  frequencyMhz: Schema.NullOr(Schema.Number),
});

const NetCountersWire = Schema.Struct({
  rxBytes: Schema.Number,
  txBytes: Schema.Number,
});

/** On-disk / ring-file shape for rate baselines. */
export const RingBaselinesSchema = Schema.Struct({
  process: Schema.optionalKey(
    Schema.Struct({
      takenMs: Schema.Number,
      /** [pid, cpuTimeUs] pairs. */
      cpuTimes: Schema.Array(Schema.Tuple([Schema.Int, Schema.Number])),
    }),
  ),
  host: Schema.optionalKey(
    Schema.Struct({
      takenMs: Schema.Number,
      cpus: Schema.Array(Schema.Tuple([Schema.Int, CpuCountersWire])),
      networks: Schema.Array(Schema.Tuple([Schema.String, NetCountersWire])),
    }),
  ),
});

export type RingBaselines = typeof RingBaselinesSchema.Type;

export const NO_BASELINES: RingBaselines = {};
