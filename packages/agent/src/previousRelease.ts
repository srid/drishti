/**
 * Previous-release window resolver (W4.8).
 *
 * Resolves the previous release tag/store for the mixed-build window e2e.
 * Arming is comparable DATA (injected tag source). Armed path: given the
 * CURRENT tag, pick the latest release tag strictly older than it (real
 * ordering). Hard-refuses previous store == current.
 */

import {
  assertPreviousReleaseWindow,
  isPreviousReleaseTag,
  type PreviousReleaseWindow,
} from "@kolu/surface-daemon/upgrade-window.testlib";

/**
 * Default production arming: null until the first daemon-capable release is
 * cut. Tests inject an explicit {@link ArmingConfig} rather than mutating this.
 */
export const DEFAULT_FIRST_DAEMON_CAPABLE_RELEASE_TAG: string | null = null;

/** Arming gate as comparable data (injection is data, not a null literal path). */
export type ArmingConfig = {
  /**
   * First release tag whose agent is a durable daemon. `null` ⇒ synthetic
   * unarmed path (same source, different baked buildId).
   */
  firstDaemonCapableReleaseTag: string | null;
};

export type TagSource = {
  /** Available release tags, newest-first preferred. */
  tags: readonly string[];
  /** Resolve a tag to its agent store path (or null if unknown). */
  storeForTag: (tag: string) => string | null;
};

export type PreviousReleaseResolution =
  | {
      kind: "synthetic-unarmed";
      reason: string;
    }
  | {
      kind: "armed";
      window: PreviousReleaseWindow;
    };

/** Parse vMAJOR.MINOR.PATCH for ordering; fail-fast on garbage. */
function parseReleaseParts(tag: string): [number, number, number] {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) {
    throw new Error(
      `previous-release tag is not orderable: ${JSON.stringify(tag)}`,
    );
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative if a is strictly older than b; 0 if equal; positive if a is newer. */
export function compareReleaseTags(a: string, b: string): number {
  const [am, an, ap] = parseReleaseParts(a);
  const [bm, bn, bp] = parseReleaseParts(b);
  if (am !== bm) return am - bm;
  if (an !== bn) return an - bn;
  return ap - bp;
}

/**
 * Resolve the previous-release window.
 *
 * - Unarmed (`firstDaemonCapableReleaseTag === null`): synthetic path.
 * - Armed: require {@link currentTag}; select the latest release tag strictly
 *   older than current (ordering is real, not "first unequal tag"); resolve
 *   its store; hard-refuse previous==current.
 */
export function resolvePreviousRelease(args: {
  arming: ArmingConfig;
  tags: TagSource;
  currentStore: string;
  /**
   * The current release tag — required when armed so predecessor ordering is
   * well-defined (W4.8). Ignored when unarmed.
   */
  currentTag?: string | null;
  /**
   * Optional explicit previous tag (overrides auto-pick from tags list).
   */
  previousTag?: string | null;
}): PreviousReleaseResolution {
  const armedAt = args.arming.firstDaemonCapableReleaseTag;
  if (armedAt === null) {
    return {
      kind: "synthetic-unarmed",
      reason:
        "firstDaemonCapableReleaseTag is null — mixed-build uses synthetic previous (same source, different baked buildId) until the first daemon-capable release arms the resolver",
    };
  }

  const currentTag = args.currentTag;
  if (currentTag === null || currentTag === undefined || currentTag === "") {
    throw new Error(
      `previous-release resolver is armed at ${armedAt} but currentTag is missing — cannot order a predecessor`,
    );
  }
  if (!isPreviousReleaseTag(currentTag)) {
    throw new Error(
      `current tag ${JSON.stringify(currentTag)} is not a release tag shape`,
    );
  }

  let previousTag = args.previousTag ?? null;
  if (previousTag === null || previousTag === undefined || previousTag === "") {
    // W5.7: ALWAYS order by compareReleaseTags — never trust list adjacency.
    const releaseTags = args.tags.tags.filter((t) => isPreviousReleaseTag(t));
    let best: string | null = null;
    for (const t of releaseTags) {
      if (compareReleaseTags(t, currentTag) >= 0) continue;
      if (best === null || compareReleaseTags(t, best) > 0) best = t;
    }
    previousTag = best;
  } else {
    if (!isPreviousReleaseTag(previousTag)) {
      throw new Error(
        `previous-release tag ${JSON.stringify(previousTag)} is not a release tag shape`,
      );
    }
    if (compareReleaseTags(previousTag, currentTag) >= 0) {
      throw new Error(
        `previous-release tag ${JSON.stringify(previousTag)} is not strictly older than currentTag ${JSON.stringify(currentTag)}`,
      );
    }
  }

  if (previousTag === null || previousTag === "") {
    throw new Error(
      `previous-release resolver is armed at ${armedAt} but no previous tag strictly older than ${JSON.stringify(currentTag)} could be resolved`,
    );
  }
  if (!isPreviousReleaseTag(previousTag)) {
    throw new Error(
      `previous-release tag ${JSON.stringify(previousTag)} is not a release tag shape`,
    );
  }

  const previousStore = args.tags.storeForTag(previousTag);
  if (previousStore === null || previousStore === "") {
    throw new Error(
      `previous-release resolver is armed but store path is missing for tag ${previousTag}`,
    );
  }

  const window: PreviousReleaseWindow = {
    ref: previousTag,
    previousStore,
    currentStore: args.currentStore,
  };
  // Hard refusal when previous equals current — pin W4.8 / W3.5.
  assertPreviousReleaseWindow(window);
  return { kind: "armed", window };
}

/** Production convenience: resolve with default arming + an injected tag source. */
export function resolvePreviousReleaseDefault(
  tags: TagSource,
  currentStore: string,
  currentTag?: string | null,
): PreviousReleaseResolution {
  return resolvePreviousRelease({
    arming: {
      firstDaemonCapableReleaseTag: DEFAULT_FIRST_DAEMON_CAPABLE_RELEASE_TAG,
    },
    tags,
    currentStore,
    currentTag,
  });
}

export function isPreviousReleaseArmed(
  arming: ArmingConfig = {
    firstDaemonCapableReleaseTag: DEFAULT_FIRST_DAEMON_CAPABLE_RELEASE_TAG,
  },
): boolean {
  return arming.firstDaemonCapableReleaseTag !== null;
}
