/**
 * Previous-release window resolver (W2.3 / Atlas UW3 Lands).
 *
 * At the first daemon-capable release tag, the window e2e resolves a real
 * previous store path and hard-refuses when previous equals current. Before
 * that tag arms, the synthetic previous (same source, different baked
 * buildId) drives the mixed-build proof — the arming condition is CODE here,
 * not a comment.
 */

import {
  assertPreviousReleaseWindow,
  isPreviousReleaseTag,
  type PreviousReleaseWindow,
} from "@kolu/surface-daemon/upgrade-window.testlib";

/**
 * The first drishti release tag whose agent is a durable daemon capable of
 * the mixed-build window. Until this ships, {@link resolvePreviousRelease}
 * returns the synthetic-unarmed path.
 *
 * Bump (or set) when cutting that release; tests pin the pre-arming state
 * against the empty sentinel.
 */
export const FIRST_DAEMON_CAPABLE_RELEASE_TAG: string | null = null;

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
 * Resolve the previous-release window for the upgrade e2e.
 *
 * - Before {@link FIRST_DAEMON_CAPABLE_RELEASE_TAG} is set: synthetic path
 *   (caller drives same-source / different-buildId bootstrap).
 * - Once armed: requires a real previous tag + store, and hard-refuses when
 *   previous store equals current (framework assertPreviousReleaseWindow).
 */
export function resolvePreviousRelease(args: {
  /** Candidate previous tag (e.g. from git describe / env). */
  previousTag: string | null;
  previousStore: string | null;
  currentStore: string;
}): PreviousReleaseResolution {
  const armedAt = FIRST_DAEMON_CAPABLE_RELEASE_TAG;
  if (armedAt === null) {
    return {
      kind: "synthetic-unarmed",
      reason:
        "FIRST_DAEMON_CAPABLE_RELEASE_TAG is unset — mixed-build uses synthetic previous (same source, different baked buildId) until the first daemon-capable release arms the real resolver",
    };
  }

  if (args.previousTag === null || args.previousTag === "") {
    throw new Error(
      `previous-release resolver is armed at ${armedAt} but no previous tag was provided`,
    );
  }
  if (!isPreviousReleaseTag(args.previousTag)) {
    throw new Error(
      `previous-release tag ${JSON.stringify(args.previousTag)} is not a release tag shape`,
    );
  }
  if (args.previousStore === null || args.previousStore === "") {
    throw new Error(
      `previous-release resolver is armed but previous store path is missing for tag ${args.previousTag}`,
    );
  }

  const window: PreviousReleaseWindow = {
    ref: args.previousTag,
    previousStore: args.previousStore,
    currentStore: args.currentStore,
  };
  // Hard refusal when previous equals current (framework gate).
  assertPreviousReleaseWindow(window);
  return { kind: "armed", window };
}

/** True when the real previous-tag path is armed (not synthetic). */
export function isPreviousReleaseArmed(): boolean {
  return FIRST_DAEMON_CAPABLE_RELEASE_TAG !== null;
}
