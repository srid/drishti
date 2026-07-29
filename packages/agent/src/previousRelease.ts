/**
 * Previous-release window resolver (W3.5).
 *
 * Resolves the previous release tag/store for the mixed-build window e2e.
 * Arming is comparable DATA (injected tag source), not a null-only constant.
 * When armed, hard-refuses previous store == current.
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

/**
 * Resolve the previous-release window.
 *
 * - Unarmed (`firstDaemonCapableReleaseTag === null`): synthetic path.
 * - Armed: pick the previous tag from the tag source (the tag immediately
 *   before / equal to the arming tag when present, else the newest prior
 *   release tag), resolve its store, hard-refuse previous==current.
 */
export function resolvePreviousRelease(args: {
  arming: ArmingConfig;
  tags: TagSource;
  currentStore: string;
  /**
   * Optional explicit previous tag (overrides auto-pick from tags list).
   * When armed and omitted, selects from `tags.tags`.
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

  let previousTag = args.previousTag ?? null;
  if (previousTag === null || previousTag === undefined || previousTag === "") {
    // Auto-pick: prefer a tag strictly before the arming tag in the list,
    // else the first release-shaped tag that isn't the arming tag alone.
    const releaseTags = args.tags.tags.filter((t) => isPreviousReleaseTag(t));
    previousTag =
      releaseTags.find((t) => t !== armedAt) ?? releaseTags[0] ?? null;
  }

  if (previousTag === null || previousTag === "") {
    throw new Error(
      `previous-release resolver is armed at ${armedAt} but no previous tag could be resolved from the tag source`,
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
  // Hard refusal when previous equals current — THIS call is the pin W3.5
  // mutations delete to go red.
  assertPreviousReleaseWindow(window);
  return { kind: "armed", window };
}

/** Production convenience: resolve with default arming + an injected tag source. */
export function resolvePreviousReleaseDefault(
  tags: TagSource,
  currentStore: string,
): PreviousReleaseResolution {
  return resolvePreviousRelease({
    arming: {
      firstDaemonCapableReleaseTag: DEFAULT_FIRST_DAEMON_CAPABLE_RELEASE_TAG,
    },
    tags,
    currentStore,
  });
}

export function isPreviousReleaseArmed(
  arming: ArmingConfig = {
    firstDaemonCapableReleaseTag: DEFAULT_FIRST_DAEMON_CAPABLE_RELEASE_TAG,
  },
): boolean {
  return arming.firstDaemonCapableReleaseTag !== null;
}
