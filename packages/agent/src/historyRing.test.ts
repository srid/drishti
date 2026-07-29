import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MetricSample } from "drishti-common";
import {
  HISTORY_RING_VERSION,
  loadHistoryRing,
  saveHistoryRing,
} from "./historyRing";

function sample(t: number): MetricSample {
  return { t, cpu: 10, mem: 20, swap: 0, disk: 30 };
}

function tempDir(): string {
  const dir = join(
    tmpdir(),
    `drishti-history-ring-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("loadHistoryRing / saveHistoryRing", () => {
  it("round-trips a happy-path ring", () => {
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "history.ring.json");
    const samples = [sample(1000), sample(2000)];
    saveHistoryRing(path, samples);

    const loaded = loadHistoryRing(path);
    expect(loaded).toEqual({ kind: "ok", samples });

    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      v: number;
      samples: MetricSample[];
    };
    expect(raw.v).toBe(HISTORY_RING_VERSION);
    expect(raw.samples).toEqual(samples);
  });

  it("treats a missing file as honest empty ok", () => {
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "history.ring.json");
    expect(loadHistoryRing(path)).toEqual({ kind: "ok", samples: [] });
  });

  it("returns unavailable unknown-version for a planted v+1 ring and leaves the file alone", () => {
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "history.ring.json");
    const planted = {
      v: HISTORY_RING_VERSION + 1,
      samples: [sample(42)],
    };
    writeFileSync(path, JSON.stringify(planted), "utf8");

    const loaded = loadHistoryRing(path);
    expect(loaded).toEqual({
      kind: "unavailable",
      reason: "unknown-version",
      samples: [],
    });

    // File must still be the planted payload — never rewritten or deleted.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(planted);
  });

  it("returns unavailable corrupt for a truncated ring and moves the file aside (never deletes)", () => {
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "history.ring.json");
    writeFileSync(path, '{"v":1,"samples":[', "utf8");

    const loaded = loadHistoryRing(path);
    expect(loaded).toEqual({
      kind: "unavailable",
      reason: "corrupt",
      samples: [],
    });

    // Original path gone; a corrupt-* sibling remains.
    let originalExists = true;
    try {
      readFileSync(path);
    } catch {
      originalExists = false;
    }
    expect(originalExists).toBe(false);

    const siblings = readdirSync(dir).filter((n) =>
      n.startsWith("history.ring.json.corrupt-"),
    );
    expect(siblings.length).toBe(1);
    // Contents preserved for autopsy.
    expect(readFileSync(join(dir, siblings[0]!), "utf8")).toBe(
      '{"v":1,"samples":[',
    );
  });

  it("returns unavailable corrupt for garbage JSON shape and moves aside", () => {
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "history.ring.json");
    writeFileSync(path, JSON.stringify({ not: "a ring" }), "utf8");

    const loaded = loadHistoryRing(path);
    expect(loaded.kind).toBe("unavailable");
    if (loaded.kind === "unavailable") {
      expect(loaded.reason).toBe("corrupt");
    }
    const siblings = readdirSync(dir).filter((n) =>
      n.includes(".corrupt-"),
    );
    expect(siblings.length).toBe(1);
  });

  it("returns unreadable (not corrupt) for an unreadable file and leaves it alone", () => {
    // F13: never-judged bytes must not be move-aside'd or later overwritten
    // by a resumed flush. chmod 0 makes the open fail with EACCES.
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "history.ring.json");
    const planted = JSON.stringify({
      v: HISTORY_RING_VERSION,
      samples: [sample(99)],
    });
    writeFileSync(path, planted, "utf8");
    chmodSync(path, 0o000);

    try {
      const loaded = loadHistoryRing(path);
      expect(loaded).toEqual({
        kind: "unavailable",
        reason: "unreadable",
        samples: [],
      });
      // File still at the original path (no .corrupt-* sibling).
      chmodSync(path, 0o600);
      expect(readFileSync(path, "utf8")).toBe(planted);
      expect(
        readdirSync(dir).filter((n) => n.includes(".corrupt-")).length,
      ).toBe(0);
    } finally {
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort restore so afterEach can rm
      }
    }
  });
});
