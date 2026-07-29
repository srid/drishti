/**
 * Pure presentation for per-host daemon status chip + dialog (kaval shape).
 *
 * Reads ONLY typed DaemonStatus discriminants — never Error.message / reason
 * prose. Unit-tested for every closed chip kind; App.tsx is a thin call site.
 *
 * U2.5: closed switch over ConvergenceAnomalyWire.kind — no Record fallback.
 * U2.6: showNudge is adopted-stale ONLY.
 */
import type {
  ConvergenceAnomalyWire,
  DaemonIdentity,
  DaemonStatus,
  HostOutcomeWire,
  UnconvergedCauseWire,
} from "../common/daemonStatus";

export type DaemonChipTone = "ok" | "warn" | "down" | "warming" | "muted";

/** Closed set of chip kinds the UI can paint. */
export type DaemonChipKind =
  | "clean"
  | "adopted-stale"
  | "skew-refused"
  | "cross-supervisor"
  | "drained-with-persist-failure"
  | "unconverged"
  | "link-failed"
  | "boot-refused"
  | "off-nix"
  | "disconnected"
  | "warming"
  | "unknown";

export type DaemonChipPresentation = {
  readonly kind: DaemonChipKind;
  readonly label: string;
  readonly tone: DaemonChipTone;
  /**
   * adopted-stale human-action nudge ONLY (U2.6) — never boot-refused.
   * Boot refusal uses its own dialog copy, not this flag.
   */
  readonly showNudge: boolean;
};

/**
 * Glance surfaces (tabs / fleet cards): QUIET WHEN HEALTHY (kaval shape).
 *
 * The connection label already paints connected / failed / disconnected /
 * probing. The daemon chip appears ONLY when it adds information beyond
 * that label — not a second green "running" pill beside "connected", and
 * not a second "link failed"/"failed" pair.
 *
 * Dialog always has full detail on demand (this gate is glance-only).
 */
export function chipGlanceVisible(p: DaemonChipPresentation): boolean {
  switch (p.kind) {
    case "adopted-stale":
    case "boot-refused":
    case "skew-refused":
    case "cross-supervisor":
    case "drained-with-persist-failure":
    case "unconverged":
    case "off-nix":
      return true;
    case "clean":
    case "link-failed":
    case "disconnected":
    case "warming":
    case "unknown":
      return false;
    default: {
      const _e: never = p.kind;
      return _e;
    }
  }
}

function chipFromAnomaly(anomaly: ConvergenceAnomalyWire): DaemonChipPresentation {
  switch (anomaly.kind) {
    case "adopted-stale":
      return {
        kind: "adopted-stale",
        label: "stale build",
        tone: "warn",
        showNudge: true,
      };
    case "skew-refused":
      return {
        kind: "skew-refused",
        label: "contract refused",
        tone: "down",
        showNudge: false,
      };
    case "cross-supervisor":
      return {
        kind: "cross-supervisor",
        label: "foreign supervisor",
        tone: "down",
        showNudge: false,
      };
    case "drained-with-persist-failure":
      return {
        kind: "drained-with-persist-failure",
        label: "persist failed",
        tone: "warn",
        showNudge: false,
      };
    case "unconverged":
      return {
        kind: "unconverged",
        label: "unconverged",
        tone: "down",
        showNudge: false,
      };
    case "link-failed":
      return {
        kind: "link-failed",
        label: "link failed",
        tone: "down",
        showNudge: false,
      };
    case "boot-refused":
      return {
        kind: "boot-refused",
        label: "boot refused",
        tone: "down",
        showNudge: false,
      };
    default: {
      const _e: never = anomaly;
      return _e;
    }
  }
}

/**
 * Map typed DaemonStatus → chip presentation.
 * Priority: standing anomaly → resolve-failed off-nix / boot-refused outcome → phase.
 */
export function chipFromDaemonStatus(
  status: DaemonStatus | null | undefined,
): DaemonChipPresentation {
  if (status === null || status === undefined) {
    return {
      kind: "unknown",
      label: "daemon…",
      tone: "muted",
      showNudge: false,
    };
  }

  if (status.anomaly !== null) {
    return chipFromAnomaly(status.anomaly);
  }

  const outcome = status.outcome;
  if (outcome?.kind === "boot-refused") {
    return {
      kind: "boot-refused",
      label: "boot refused",
      tone: "down",
      showNudge: false,
    };
  }
  if (
    outcome?.kind === "resolve-failed" &&
    outcome.resolutionKind === "unavailable"
  ) {
    return {
      kind: "off-nix",
      label: "off-nix",
      tone: "muted",
      showNudge: false,
    };
  }

  const phase = status.phase;
  if (
    phase === "probing" ||
    phase === "provisioning" ||
    phase === "connecting"
  ) {
    return {
      kind: "warming",
      label: "starting…",
      tone: "warming",
      showNudge: false,
    };
  }

  if (phase === "connected") {
    return {
      kind: "clean",
      label: "running",
      tone: "ok",
      showNudge: false,
    };
  }

  if (phase === "disconnected" || phase === "failed") {
    return {
      kind: "disconnected",
      label: phase === "failed" ? "failed" : "disconnected",
      tone: phase === "failed" ? "down" : "muted",
      showNudge: false,
    };
  }

  return {
    kind: "unknown",
    label: "daemon…",
    tone: "muted",
    showNudge: false,
  };
}

export const CHIP_TONE_CLASS: Record<DaemonChipTone, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  down: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  warming:
    "border-amber-500/30 bg-amber-500/5 text-amber-700 animate-pulse dark:text-amber-400",
  muted:
    "border-gray-300 bg-gray-100 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

export type BannerPresentation = {
  readonly title: string;
  readonly tone: "warn" | "down";
  /** Structured evidence lines (never from detail prose parsing). */
  readonly evidence: readonly string[];
  /**
   * When set, dialog shows boot-refusal recovery copy (U2.6) — not the
   * adopted-stale Renew nudge.
   */
  readonly bootRefusedMessage?: string;
};

function causeEvidence(cause: UnconvergedCauseWire): string[] {
  switch (cause.kind) {
    case "budget-exhausted":
      return [
        `cause budget-exhausted · axis ${cause.axis} · ${cause.attempts}/${cause.maxAttempts}`,
      ];
    case "drain-not-taken":
      return [
        `cause drain-not-taken · axis ${cause.axis} · ceiling ${cause.ceilingMs}ms` +
          (cause.rejection !== null ? ` · ${cause.rejection}` : ""),
      ];
    case "adopt-bind-failed":
      return [
        `cause adopt-bind-failed · axis ${cause.axis ?? "null"}`,
      ];
    case "identity-unverifiable":
      return ["cause identity-unverifiable"];
    case "probe-failed":
      return [`cause probe-failed · ${cause.message}`];
    default: {
      const _e: never = cause;
      return [_e];
    }
  }
}

/** Dialog banner from typed anomaly arms only. */
export function anomalyBanner(
  anomaly: ConvergenceAnomalyWire | null,
): BannerPresentation | null {
  if (anomaly === null) return null;
  switch (anomaly.kind) {
    case "adopted-stale":
      return {
        title: "stale build",
        tone: "warn",
        evidence: [
          `running ${buildLabel(anomaly.running.build)} · expected ${buildLabel(anomaly.expected.build)}`,
          anomaly.detail,
        ],
      };
    case "skew-refused":
      return {
        title: "contract refused",
        tone: "down",
        evidence: [
          `contract ${anomaly.running.contractVersion} → ${anomaly.expected.contractVersion}`,
          anomaly.detail,
        ],
      };
    case "cross-supervisor":
      return {
        title: "foreign supervisor",
        tone: "down",
        evidence: [
          `drained ${instanceLabel(anomaly.drained)} · observed ${instanceLabel(anomaly.observed)}`,
          anomaly.detail,
        ],
      };
    case "unconverged":
      return {
        title: "unconverged",
        tone: "down",
        evidence: [...causeEvidence(anomaly.cause), anomaly.detail],
      };
    case "drained-with-persist-failure":
      return {
        title: "persist failed",
        tone: "warn",
        evidence: [anomaly.error, anomaly.detail],
      };
    case "link-failed":
      return {
        title: "link failed",
        tone: "down",
        evidence: [anomaly.detail],
      };
    case "boot-refused":
      return {
        title: "boot refused",
        tone: "down",
        evidence: [anomaly.message],
        bootRefusedMessage: anomaly.message,
      };
    default: {
      const _e: never = anomaly;
      return _e;
    }
  }
}

function buildLabel(
  b: { kind: "known"; id: string } | { kind: "off-nix" },
): string {
  return b.kind === "known" ? b.id.slice(0, 12) : "(off-nix)";
}

function instanceLabel(
  k: { kind: "instance"; key: string | number } | { kind: "pre-instance" },
): string {
  return k.kind === "instance" ? String(k.key) : "pre-instance";
}

/** Outcome one-liner for the dialog (typed fields only). */
export function outcomeSummary(
  outcome: HostOutcomeWire | null,
): string | null {
  if (outcome === null) return null;
  switch (outcome.kind) {
    case "replaced":
      return `last admit: replaced (${outcome.axis})`;
    case "refused":
      return `last admit: refused (${outcome.anomalyKind})`;
    case "adopted":
      return "last admit: adopted";
    case "adopted-stale":
      return `last admit: adopted-stale (${outcome.anomalyKind})`;
    case "resolve-failed":
      return `last admit: resolve-failed (${outcome.resolutionKind})`;
    case "boot-refused":
      return `boot refused: ${outcome.message}`;
    default: {
      const _e: never = outcome;
      return _e;
    }
  }
}

/** Identity rows for dialog — missing fields stay "—" (honest unknown). */
export function identityRows(
  identity: DaemonIdentity | null,
): readonly { label: string; value: string }[] {
  const dash = "—";
  if (identity === null) {
    return [
      { label: "buildId", value: dash },
      { label: "commit", value: dash },
      { label: "contract", value: dash },
      { label: "startedAt", value: dash },
      { label: "stateRoot", value: dash },
    ];
  }
  return [
    { label: "buildId", value: identity.buildId ?? dash },
    { label: "commit", value: identity.commit ?? dash },
    { label: "contract", value: identity.contractVersion ?? dash },
    {
      label: "startedAt",
      value:
        identity.startedAt !== null
          ? new Date(identity.startedAt).toISOString()
          : dash,
    },
    { label: "stateRoot", value: identity.stateRoot ?? dash },
  ];
}

/** Fold renew procedure result into UI state (not console). */
export type RenewUiState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly error: string };

export function applyRenewStart(_prev: RenewUiState): RenewUiState {
  return { kind: "pending" };
}

export function applyRenewResult(
  result: { ok: boolean; error?: string },
): RenewUiState {
  if (result.ok) return { kind: "ok" };
  return {
    kind: "error",
    error: result.error ?? "renew failed",
  };
}

/** Fold successful daemonStatus poll. */
export function applyDaemonStatusOk(status: DaemonStatus): {
  status: DaemonStatus;
  pollError: null;
} {
  return { status, pollError: null };
}

/**
 * Poll failure retains standing status (same standing law as convergence).
 */
export function applyDaemonStatusError(
  prev: DaemonStatus | null,
  message: string,
): { status: DaemonStatus | null; pollError: string } {
  return { status: prev, pollError: message };
}
