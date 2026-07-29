/**
 * Pure presentation for per-host daemon status chip + dialog (kaval shape).
 *
 * Reads ONLY typed DaemonStatus discriminants — never Error.message / reason
 * prose. Unit-tested for every chip kind; App.tsx is a thin call site.
 */
import type {
  ConvergenceAnomalyWire,
  DaemonIdentity,
  DaemonStatus,
  HostOutcomeWire,
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
  /** adopted-stale human-action nudge (kaval update-nudge philosophy). */
  readonly showNudge: boolean;
};

const CHIP_BY_ANOMALY: Record<
  string,
  Pick<DaemonChipPresentation, "kind" | "label" | "tone" | "showNudge">
> = {
  "adopted-stale": {
    kind: "adopted-stale",
    label: "stale build",
    tone: "warn",
    showNudge: true,
  },
  "skew-refused": {
    kind: "skew-refused",
    label: "contract refused",
    tone: "down",
    showNudge: false,
  },
  "cross-supervisor": {
    kind: "cross-supervisor",
    label: "foreign supervisor",
    tone: "down",
    showNudge: false,
  },
  "drained-with-persist-failure": {
    kind: "drained-with-persist-failure",
    label: "persist failed",
    tone: "warn",
    showNudge: false,
  },
  unconverged: {
    kind: "unconverged",
    label: "unconverged",
    tone: "down",
    showNudge: false,
  },
  "link-failed": {
    kind: "link-failed",
    label: "link failed",
    tone: "down",
    showNudge: false,
  },
  "boot-refused": {
    kind: "boot-refused",
    label: "boot refused",
    tone: "down",
    showNudge: true,
  },
};

/**
 * Map typed DaemonStatus → chip presentation.
 * Priority: standing anomaly → resolve-failed off-nix → phase.
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

  const anomaly = status.anomaly;
  if (anomaly !== null) {
    const row = CHIP_BY_ANOMALY[anomaly.kind];
    if (row !== undefined) return row;
    // Unknown anomaly kind: still typed as down, label = kind discriminant only.
    return {
      kind: "unknown",
      label: anomaly.kind,
      tone: "down",
      showNudge: false,
    };
  }

  const outcome = status.outcome;
  if (outcome?.kind === "boot-refused") {
    return {
      kind: "boot-refused",
      label: "boot refused",
      tone: "down",
      showNudge: true,
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
  muted: "border-gray-300 bg-gray-100 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

export type BannerPresentation = {
  readonly title: string;
  readonly tone: "warn" | "down";
  /** Structured evidence lines (never from detail prose parsing). */
  readonly evidence: readonly string[];
};

/** Dialog banner from typed anomaly arms only. */
export function anomalyBanner(
  anomaly: ConvergenceAnomalyWire | null,
): BannerPresentation | null {
  if (anomaly === null) return null;
  const row = CHIP_BY_ANOMALY[anomaly.kind];
  const title = row?.label ?? anomaly.kind;
  const tone: "warn" | "down" =
    row?.tone === "warn" ? "warn" : "down";
  const evidence: string[] = [];
  if (anomaly.running !== undefined && anomaly.expected !== undefined) {
    if (
      anomaly.kind === "adopted-stale" ||
      anomaly.kind === "skew-refused"
    ) {
      evidence.push(
        `running ${buildLabel(anomaly.running.build)} · expected ${buildLabel(anomaly.expected.build)}`,
      );
      if (anomaly.kind === "skew-refused") {
        evidence.push(
          `contract ${anomaly.running.contractVersion} → ${anomaly.expected.contractVersion}`,
        );
      }
    }
  }
  if (anomaly.drained !== undefined && anomaly.observed !== undefined) {
    evidence.push(
      `drained ${instanceLabel(anomaly.drained)} · observed ${instanceLabel(anomaly.observed)}`,
    );
  }
  if (anomaly.error !== undefined) {
    evidence.push(anomaly.error);
  }
  // detail is human garnish — show as last evidence line without parsing.
  if (anomaly.detail.length > 0) {
    evidence.push(anomaly.detail);
  }
  return { title, tone, evidence };
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
