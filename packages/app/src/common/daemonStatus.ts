/**
 * Typed daemon status projection shared by admin wire + client UI.
 *
 * UI reads ONLY these discriminants — never free-form Error.message /
 * reason prose (UW3 campaign standing law).
 */
import { z } from "zod";

/** Frozen-fragment identity fields the parent probes at admit. */
export const DaemonIdentitySchema = z.object({
  stateRoot: z.string().nullable(),
  contractVersion: z.string().nullable(),
  startedAt: z.number().nullable(),
  commit: z.string().nullable(),
  buildId: z.string().nullable(),
});
export type DaemonIdentity = z.infer<typeof DaemonIdentitySchema>;

/** HostSession.outcome() as wire JSON. */
export const HostOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replaced"),
    axis: z.enum(["build", "contract"]),
  }),
  z.object({
    kind: z.literal("refused"),
    anomalyKind: z.string(),
  }),
  z.object({ kind: z.literal("adopted") }),
  z.object({
    kind: z.literal("adopted-stale"),
    anomalyKind: z.string(),
  }),
  z.object({
    kind: z.literal("resolve-failed"),
    resolutionKind: z.string(),
  }),
]);
export type HostOutcomeWire = z.infer<typeof HostOutcomeSchema>;

const BuildWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("known"), id: z.string() }),
  z.object({ kind: z.literal("off-nix") }),
]);

const ConvergenceIdentityWireSchema = z.object({
  contractVersion: z.string(),
  build: BuildWireSchema,
});

const InstanceKeyWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instance"), key: z.union([z.string(), z.number()]) }),
  z.object({ kind: z.literal("pre-instance") }),
]);

/**
 * Standing convergence anomaly — kind is the discriminant; typed evidence
 * fields ride only on the arms that carry them (never parsed from detail).
 */
export const ConvergenceAnomalyWireSchema = z.object({
  kind: z.string(),
  detail: z.string(),
  error: z.string().optional(),
  running: ConvergenceIdentityWireSchema.optional(),
  expected: ConvergenceIdentityWireSchema.optional(),
  drained: InstanceKeyWireSchema.optional(),
  observed: InstanceKeyWireSchema.optional(),
});
export type ConvergenceAnomalyWire = z.infer<typeof ConvergenceAnomalyWireSchema>;

/** Full per-host daemon status for the UI chip + dialog. */
export const DaemonStatusSchema = z.object({
  anomaly: ConvergenceAnomalyWireSchema.nullable(),
  outcome: HostOutcomeSchema.nullable(),
  identity: DaemonIdentitySchema.nullable(),
  /** Session phase word (connection authority) — structural, not prose. */
  phase: z.string(),
});
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;
