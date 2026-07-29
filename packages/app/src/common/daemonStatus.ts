/**
 * Typed daemon status projection shared by admin wire + client UI.
 *
 * UI reads ONLY these discriminants — never free-form Error.message /
 * reason prose (UW3 campaign standing law).
 *
 * U2.5: ConvergenceAnomalyWire is a CLOSED discriminated union — each arm
 * preserves required evidence; an added server arm is an exhaustiveness failure.
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

const AxisSchema = z.enum(["build", "contract"]);

/** HostSession.outcome() as wire JSON — closed kinds. */
export const HostOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replaced"),
    axis: AxisSchema,
  }),
  z.object({
    kind: z.literal("refused"),
    anomalyKind: z.enum([
      "adopted-stale",
      "skew-refused",
      "unconverged",
      "cross-supervisor",
    ]),
  }),
  z.object({ kind: z.literal("adopted") }),
  z.object({
    kind: z.literal("adopted-stale"),
    anomalyKind: z.literal("adopted-stale"),
  }),
  z.object({
    kind: z.literal("resolve-failed"),
    resolutionKind: z.enum([
      "unavailable",
      "source-unbaked",
      "nix-unavailable",
      "network-exhausted",
    ]),
  }),
  z.object({
    kind: z.literal("boot-refused"),
    /** Verbatim agent fatal message (prefixed line payload only). */
    message: z.string(),
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
  z.object({
    kind: z.literal("instance"),
    key: z.union([z.string(), z.number()]),
  }),
  z.object({ kind: z.literal("pre-instance") }),
]);

/** Framework UnconvergedCause — closed on the wire (U2.5). */
export const UnconvergedCauseWireSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("budget-exhausted"),
    axis: AxisSchema,
    attempts: z.number(),
    maxAttempts: z.number(),
  }),
  z.object({
    kind: z.literal("drain-not-taken"),
    axis: AxisSchema,
    ceilingMs: z.number(),
    rejection: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("adopt-bind-failed"),
    axis: AxisSchema.nullable(),
  }),
  z.object({ kind: z.literal("identity-unverifiable") }),
  z.object({
    kind: z.literal("probe-failed"),
    message: z.string(),
  }),
]);
export type UnconvergedCauseWire = z.infer<typeof UnconvergedCauseWireSchema>;

/**
 * Standing convergence anomaly — CLOSED discriminated union.
 * Required evidence per arm; never optional "maybe present" fields.
 */
export const ConvergenceAnomalyWireSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("adopted-stale"),
    detail: z.string(),
    running: ConvergenceIdentityWireSchema,
    expected: ConvergenceIdentityWireSchema,
  }),
  z.object({
    kind: z.literal("skew-refused"),
    detail: z.string(),
    running: ConvergenceIdentityWireSchema,
    expected: ConvergenceIdentityWireSchema,
  }),
  z.object({
    kind: z.literal("unconverged"),
    detail: z.string(),
    running: ConvergenceIdentityWireSchema.nullable(),
    expected: ConvergenceIdentityWireSchema,
    cause: UnconvergedCauseWireSchema,
  }),
  z.object({
    kind: z.literal("cross-supervisor"),
    detail: z.string(),
    drained: InstanceKeyWireSchema,
    observed: InstanceKeyWireSchema,
    running: ConvergenceIdentityWireSchema,
  }),
  z.object({
    kind: z.literal("link-failed"),
    detail: z.string(),
  }),
  z.object({
    kind: z.literal("drained-with-persist-failure"),
    detail: z.string(),
    error: z.string(),
  }),
  z.object({
    kind: z.literal("boot-refused"),
    detail: z.string(),
    /** Verbatim agent fatal message (same as outcome.message). */
    message: z.string(),
  }),
]);
export type ConvergenceAnomalyWire = z.infer<typeof ConvergenceAnomalyWireSchema>;

/** Runtime parse pin for closed wire (U2.5 mutation: open schema fails this). */
export function parseConvergenceAnomalyWire(
  value: unknown,
): ConvergenceAnomalyWire {
  return ConvergenceAnomalyWireSchema.parse(value);
}

/** Session phase words the pool/session publish. */
export const SessionPhaseSchema = z.enum([
  "probing",
  "provisioning",
  "connecting",
  "connected",
  "disconnected",
  "failed",
  "unknown",
]);
export type SessionPhaseWire = z.infer<typeof SessionPhaseSchema>;

/** Full per-host daemon status for the UI chip + dialog. */
export const DaemonStatusSchema = z.object({
  anomaly: ConvergenceAnomalyWireSchema.nullable(),
  outcome: HostOutcomeSchema.nullable(),
  identity: DaemonIdentitySchema.nullable(),
  phase: SessionPhaseSchema,
});
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;
