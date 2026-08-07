/**
 * Typed daemon status projection shared by admin wire + client UI.
 *
 * UI reads ONLY these discriminants — never free-form Error.message /
 * reason prose (UW3 campaign standing law).
 *
 * U2.5: ConvergenceAnomalyWire is a CLOSED discriminated union — each arm
 * preserves required evidence; an added server arm is an exhaustiveness failure.
 *
 * Every union here is `Schema.Union`, never `Schema.TaggedUnion`: the
 * discriminant is `kind`, and a tagged union would rename it to `_tag` — these
 * shapes cross the admin socket to the browser and their bytes are frozen.
 */
import { Schema } from "effect";

/** Frozen-fragment identity fields the parent probes at admit. */
export const DaemonIdentitySchema = Schema.Struct({
  stateRoot: Schema.NullOr(Schema.String),
  contractVersion: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
  commit: Schema.NullOr(Schema.String),
  buildId: Schema.NullOr(Schema.String),
});
export type DaemonIdentity = typeof DaemonIdentitySchema.Type;

const AxisSchema = Schema.Literals(["build", "contract"]);

/** HostSession.outcome() as wire JSON — closed kinds. */
export const HostOutcomeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("replaced"),
    axis: AxisSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    anomalyKind: Schema.Literals([
      "adopted-stale",
      "skew-refused",
      "unconverged",
      "cross-supervisor",
    ]),
  }),
  Schema.Struct({ kind: Schema.Literal("adopted") }),
  Schema.Struct({
    kind: Schema.Literal("adopted-stale"),
    anomalyKind: Schema.Literal("adopted-stale"),
  }),
  Schema.Struct({
    kind: Schema.Literal("resolve-failed"),
    resolutionKind: Schema.Literals([
      "unavailable",
      "source-unbaked",
      "nix-unavailable",
      "network-exhausted",
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("boot-refused"),
    /** Verbatim agent fatal message (prefixed line payload only). */
    message: Schema.String,
  }),
]);
export type HostOutcomeWire = typeof HostOutcomeSchema.Type;

const BuildWireSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("known"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("off-nix") }),
]);

const ConvergenceIdentityWireSchema = Schema.Struct({
  contractVersion: Schema.String,
  build: BuildWireSchema,
});

const InstanceKeyWireSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("instance"),
    key: Schema.Union([Schema.String, Schema.Number]),
  }),
  Schema.Struct({ kind: Schema.Literal("pre-instance") }),
]);

/** Framework UnconvergedCause — closed on the wire (U2.5). */
export const UnconvergedCauseWireSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("budget-exhausted"),
    axis: AxisSchema,
    attempts: Schema.Number,
    maxAttempts: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("drain-not-taken"),
    axis: AxisSchema,
    ceilingMs: Schema.Number,
    rejection: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("adopt-bind-failed"),
    axis: Schema.NullOr(AxisSchema),
  }),
  Schema.Struct({ kind: Schema.Literal("identity-unverifiable") }),
  Schema.Struct({
    kind: Schema.Literal("probe-failed"),
    message: Schema.String,
  }),
  /**
   * PLAN D6 / review #3, new with the Effect protocol epoch: the daemon at our
   * rendezvous answered our first frame with bytes this supervisor cannot
   * decode — it speaks the PREVIOUS epoch (oRPC's base64 peer framing). Not a
   * version skew: a version is something you read off a wire you can speak.
   *
   * Raised ONLY for a peer whose gate file is ours and whose pid we verified,
   * so a stranger squatting the socket still folds to `probe-failed`. drishti's
   * policy never recycles, so this always arrives on a `refused` outcome: the
   * survivor is left standing and the operator must stop it out of band.
   */
  Schema.Struct({
    kind: Schema.Literal("unspeakable-protocol"),
    socketPath: Schema.String,
    gatePath: Schema.String,
    /** The verified holder pid — the daemon left standing. */
    pid: Schema.Number,
  }),
]);
export type UnconvergedCauseWire = typeof UnconvergedCauseWireSchema.Type;

/**
 * Standing convergence anomaly — CLOSED discriminated union.
 * Required evidence per arm; never optional "maybe present" fields.
 */
export const ConvergenceAnomalyWireSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("adopted-stale"),
    detail: Schema.String,
    running: ConvergenceIdentityWireSchema,
    expected: ConvergenceIdentityWireSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("skew-refused"),
    detail: Schema.String,
    running: ConvergenceIdentityWireSchema,
    expected: ConvergenceIdentityWireSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("unconverged"),
    detail: Schema.String,
    running: Schema.NullOr(ConvergenceIdentityWireSchema),
    expected: ConvergenceIdentityWireSchema,
    cause: UnconvergedCauseWireSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("cross-supervisor"),
    detail: Schema.String,
    drained: InstanceKeyWireSchema,
    observed: InstanceKeyWireSchema,
    running: ConvergenceIdentityWireSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("link-failed"),
    detail: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("drained-with-persist-failure"),
    detail: Schema.String,
    error: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("boot-refused"),
    detail: Schema.String,
    /** Verbatim agent fatal message (same as outcome.message). */
    message: Schema.String,
  }),
]);
export type ConvergenceAnomalyWire =
  typeof ConvergenceAnomalyWireSchema.Type;

/** Runtime parse pin for closed wire (U2.5 mutation: open schema fails this).
 *  `decodeUnknownSync` THROWS, exactly as zod's `.parse` did — a wire value
 *  that does not fit the closed union is a defect, never a shape to degrade
 *  around. */
export const parseConvergenceAnomalyWire: (
  value: unknown,
) => ConvergenceAnomalyWire = Schema.decodeUnknownSync(
  ConvergenceAnomalyWireSchema,
);

/** Session phase words the pool/session publish. */
export const SessionPhaseSchema = Schema.Literals([
  "probing",
  "provisioning",
  "connecting",
  "connected",
  "disconnected",
  "failed",
  "unknown",
]);
export type SessionPhaseWire = typeof SessionPhaseSchema.Type;

/** Full per-host daemon status for the UI chip + dialog. */
export const DaemonStatusSchema = Schema.Struct({
  anomaly: Schema.NullOr(ConvergenceAnomalyWireSchema),
  outcome: Schema.NullOr(HostOutcomeSchema),
  identity: Schema.NullOr(DaemonIdentitySchema),
  phase: SessionPhaseSchema,
});
export type DaemonStatus = typeof DaemonStatusSchema.Type;
