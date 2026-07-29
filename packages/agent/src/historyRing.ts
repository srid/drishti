/**
 * Durable on-disk metric-history ring for the agent daemon.
 *
 * File shape: `{ v: number, samples: MetricSample[] }` at
 * `~/.local/state/drishti/history.ring.json` (via `daemonHome.file(...)`).
 *
 * Dispositions are TYPED — never a silently empty chart on a corrupt or
 * unknown-version ring:
 *   - missing file → honest empty (`ok` with `[]`)
 *   - unknown `v`  → leave the file alone, return `unavailable`/`unknown-version`
 *   - garbage/truncated → rename aside to `history.ring.json.corrupt-<ts>`
 *     (NEVER delete), return `unavailable`/`corrupt`
 *
 * Writes are atomic (temp in same dir + rename).
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
import type { HistoryView } from "drishti-common/history";
import { z } from "zod";

function log(...args: unknown[]): void {
  process.stderr.write(
    `historyRing: ${args.map((a) => String(a)).join(" ")}\n`,
  );
}

/** On-disk ring schema version. Bump only with a reader migration path. */
export const HISTORY_RING_VERSION = 1;

/** File basename under the daemon home. */
export const HISTORY_RING_FILE = "history.ring.json";

const RingFileSchema = z.object({
  v: z.number().int(),
  samples: z.array(MetricSampleSchema),
});

/** Load disposition — same shape as HistoryView (ok ring or typed unavailable). */
export type HistoryRingLoad = HistoryView;

/** Load a history ring from `path`. Missing file is honest empty. Unknown
 *  version leaves the file alone. Garbage is moved aside, never deleted. */
export function loadHistoryRing(path: string): HistoryRingLoad {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { kind: "ok", samples: [] };
    }
    // Unreadable (EACCES, transient EIO/EMFILE, …): typed unavailable without
    // move-aside — we never judged the bytes. Caller must NOT resume
    // persistence over the still-present file (F13: that would clobber it).
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

  const shape = RingFileSchema.safeParse(parsed);
  if (!shape.success) {
    moveCorruptAside(path);
    return unavailable("corrupt");
  }

  if (shape.data.v !== HISTORY_RING_VERSION) {
    // Unknown version: leave the file alone so a future reader (or the
    // writer that produced it) can still use it. Report typed unavailability.
    return unavailable("unknown-version");
  }

  return { kind: "ok", samples: shape.data.samples };
}

/** Atomic write: temp in the same directory, then rename over the target. */
export function saveHistoryRing(
  path: string,
  samples: readonly MetricSample[],
): void {
  const dir = dirname(path);
  const tmp = join(dir, `.history.ring.json.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({
    v: HISTORY_RING_VERSION,
    samples: [...samples],
  } satisfies z.infer<typeof RingFileSchema>);
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
  return { kind: "unavailable", reason, samples: [] };
}

/** Move a corrupt ring aside. NEVER deletes — a future autopsy may need it. */
function moveCorruptAside(path: string): void {
  const aside = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, aside);
  } catch (err) {
    // If the rename itself fails (race, permissions), leave the original
    // in place rather than delete — fail-loud via the typed unavailable
    // return; the caller already has the disposition.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    log(
      `move-aside failed for ${path}: ${(err as Error).message} (left in place)`,
    );
  }
}
