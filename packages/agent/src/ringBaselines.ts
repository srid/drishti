/**
 * Serializable rate baselines for the durable history ring (W2.4).
 *
 * Process + host families live in the agent `proc` reader as Maps; on flush
 * they ride the ring file so a drain→successor does not show a zero-rate first
 * tick. Pure encode/decode — no I/O.
 */

import { z } from "zod";

const CpuCountersWire = z.object({
  userUs: z.number(),
  systemUs: z.number(),
  idleUs: z.number(),
  otherUs: z.number(),
  model: z.string(),
  frequencyMhz: z.number().nullable(),
});

const NetCountersWire = z.object({
  rxBytes: z.number(),
  txBytes: z.number(),
});

/** On-disk / ring-file shape for rate baselines. */
export const RingBaselinesSchema = z.object({
  process: z
    .object({
      takenMs: z.number(),
      /** [pid, cpuTimeUs] pairs. */
      cpuTimes: z.array(z.tuple([z.number().int(), z.number()])),
    })
    .optional(),
  host: z
    .object({
      takenMs: z.number(),
      cpus: z.array(z.tuple([z.number().int(), CpuCountersWire])),
      networks: z.array(z.tuple([z.string(), NetCountersWire])),
    })
    .optional(),
});

export type RingBaselines = z.infer<typeof RingBaselinesSchema>;

export const NO_BASELINES: RingBaselines = {};
