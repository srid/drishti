/**
 * Durable on-disk metric-history ring for the agent daemon.
 *
 * File shape: `{ v, samples, alerts? }` at
 * `~/.local/state/drishti/history.ring.json` (via `daemonHome.file(...)`).
 *
 * Dispositions are TYPED — never a silently empty chart:
 *   - missing file → honest empty (`ok` with `[]`)
 *   - unknown `v`  → leave the file alone, return `unavailable`/`unknown-version`
 *     (version check BEFORE full-shape validation — W3)
 *   - garbage/truncated → rename aside to `history.ring.json.corrupt-<ts>`
 *     (NEVER delete), return `unavailable`/`corrupt`
 *   - unreadable → leave alone, return `unavailable`/`unreadable`
 *
 * Writes are atomic (temp in same dir + rename). Write failure is the caller's
 * job to surface as a typed degraded state (W10) — this module throws.
 */

import {
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  MetricSampleSchema,
  type MetricHistoryUnavailableReason,
  type MetricSample,
} from "drishti-common";
import {
  AlertsSchema,
  type Alerts,
  NO_ALERTS,
} from "drishti-common/alerts";
import type { HistoryView } from "drishti-common/history";
import { z } from "zod";
import {
  NO_BASELINES,
  RingBaselinesSchema,
  type RingBaselines,
} from "./ringBaselines";

function log(...args: unknown[]): void {
  process.stderr.write(
    `historyRing: ${args.map((a) => String(a)).join(" ")}\n`,
  );
}

/** On-disk ring schema version. Bump only with a reader migration path. */
export const HISTORY_RING_VERSION = 1;

/** File basename under the daemon home. */
export const HISTORY_RING_FILE = "history.ring.json";

/** Current-version on-disk payload — only applied after `v` is known current. */
const CurrentRingFileSchema = z.object({
  v: z.literal(HISTORY_RING_VERSION),
  samples: z.array(MetricSampleSchema),
  /** Optional hysteresis fold state — absent ⇒ NO_ALERTS on restore. */
  alerts: AlertsSchema.optional(),
  /** Optional rate baselines (process + host) — absent ⇒ cold first tick. */
  baselines: RingBaselinesSchema.optional(),
});

export type HistoryRingFile = {
  samples: MetricSample[];
  alerts: Alerts;
  baselines: RingBaselines;
};

/** Load disposition — HistoryView plus restored alert + baseline fold state. */
export type HistoryRingLoad =
  | (HistoryView & { kind: "ok"; alerts: Alerts; baselines: RingBaselines })
  | (HistoryView & {
      kind: "unavailable";
      alerts: Alerts;
      baselines: RingBaselines;
    })
  | (HistoryView & {
      kind: "degraded";
      alerts: Alerts;
      baselines: RingBaselines;
    });

/** Load a history ring from `path`. Missing file is honest empty. Unknown
 *  version leaves the file alone. Garbage is moved aside, never deleted. */
export function loadHistoryRing(path: string): HistoryRingLoad {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        kind: "ok",
        samples: [],
        alerts: NO_ALERTS,
        baselines: NO_BASELINES,
      };
    }
    log(`read failed (${code ?? "unknown"}): ${(err as Error).message}`);
    return unavailable("unreadable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    moveCorruptAside(path);
    return unavailable("corrupt");
  }

  // W3: version check BEFORE full current-version shape validation.
  // A future payload with a different samples shape must not be renamed
  // as corrupt — leave the file alone and report unknown-version.
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "v" in parsed &&
    typeof (parsed as { v: unknown }).v === "number" &&
    (parsed as { v: number }).v !== HISTORY_RING_VERSION
  ) {
    return unavailable("unknown-version");
  }

  const shape = CurrentRingFileSchema.safeParse(parsed);
  if (!shape.success) {
    moveCorruptAside(path);
    return unavailable("corrupt");
  }

  return {
    kind: "ok",
    samples: shape.data.samples,
    alerts: shape.data.alerts ?? NO_ALERTS,
    baselines: shape.data.baselines ?? NO_BASELINES,
  };
}

/** Atomic write of samples + alert fold + rate baselines. Throws on failure. */
export function saveHistoryRing(
  path: string,
  samples: readonly MetricSample[],
  alerts: Alerts = NO_ALERTS,
  baselines: RingBaselines = NO_BASELINES,
): void {
  const dir = dirname(path);
  const tmp = join(dir, `.history.ring.json.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({
    v: HISTORY_RING_VERSION,
    samples: [...samples],
    alerts,
    baselines,
  } satisfies z.infer<typeof CurrentRingFileSchema>);
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort temp cleanup; rethrow the rename failure.
    }
    throw err;
  }
}

function unavailable(
  reason: MetricHistoryUnavailableReason,
): HistoryRingLoad {
  return {
    kind: "unavailable",
    reason,
    samples: [],
    alerts: NO_ALERTS,
    baselines: NO_BASELINES,
  };
}

/** Move a corrupt ring aside. NEVER deletes — a future autopsy may need it. */
function moveCorruptAside(path: string): void {
  const aside = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    log(
      `move-aside failed for ${path}: ${(err as Error).message} (left in place)`,
    );
  }
}
