import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SharedArtifact,
  daemonHome,
} from "@kolu/surface-daemon";
import { createSharedArtifactWatchdog } from "@kolu/surface-daemon/upgrade-window.testlib";
import { HISTORY_RING_FILE, HISTORY_RING_VERSION } from "./historyRing";

/**
 * Consumer-side inventory: framework gate+socket artifacts (from
 * `daemonHome(...).artifacts`) plus the durable history ring.
 * `coveredByTest` names the disposition suite that plants v+1 and truncated
 * rings — a versionField alone never excuses a missing test.
 */
function drishtiArtifacts(home: {
  artifacts: readonly SharedArtifact[];
  file: (name: string) => string;
}): SharedArtifact[] {
  // pathShape for the history ring mirrors the gate/socket root emitted by
  // artifactsFor — derive it so the registry cannot drift from daemonHome.
  const gate = home.artifacts.find((a) => a.role === "gate");
  if (gate === undefined) {
    throw new Error("daemonHome.artifacts must include a gate entry");
  }
  const pathShapeRoot = gate.pathShape.slice(0, gate.pathShape.lastIndexOf("/"));
  return [
    ...home.artifacts,
    {
      id: "history-ring",
      pathShape: `${pathShapeRoot}/${HISTORY_RING_FILE}`,
      role: "session",
      coveredByTest: "historyRing.test.ts",
      versionField: "v",
      diskBasenames: [HISTORY_RING_FILE],
      diskBasenamePatterns: [/^history\.ring\.json\.corrupt-\d+$/],
      why: "metric history survives parent deploys and reconnects; typed unavailable on corrupt/unknown-version",
    },
  ];
}

describe("drishti shared-artifact registry", () => {
  it("registers gate, socket, and history ring with disposition coverage", () => {
    const prev = process.env.HOME;
    const tmp = mkdtempSync(join(tmpdir(), "drishti-artifacts-"));
    try {
      process.env.HOME = tmp;
      // Materialise a real daemon home so gate+socket ids come from
      // artifactsFor (drishti-gate / drishti-socket), not a hand-rolled stub.
      const home = daemonHome({ app: "drishti", placement: "state" });
      const registry = drishtiArtifacts(home);

      const ids = registry.map((a) => a.id);
      expect(ids).toContain("drishti-gate");
      expect(ids).toContain("drishti-socket");
      expect(ids).toContain("history-ring");

      const watchdog = createSharedArtifactWatchdog(registry);
      watchdog.assertInventory(["drishti-gate", "drishti-socket", "history-ring"]);

      // Disposition coverage: only history-ring requires a planted v+1 suite
      // (gate/socket are framework-emitted and covered upstream). Logs skipped.
      const gaps = watchdog.coverageGaps(
        new Set(["historyRing.test.ts", "artifacts.test.ts"]),
      );
      // gate/socket have coveredByTest: null → reported as gaps unless role=log.
      // Framework-emitted entries begin null until a consumer attaches coverage;
      // we only assert the history ring is covered.
      expect(
        gaps.filter((g) => g.startsWith("history-ring")),
      ).toEqual([]);

      const ring = registry.find((a) => a.id === "history-ring");
      expect(ring?.versionField).toBe("v");
      expect(ring?.coveredByTest).toBe("historyRing.test.ts");
      expect(HISTORY_RING_VERSION).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("materialises a private state home under a temp HOME", () => {
    const prev = process.env.HOME;
    const tmp = mkdtempSync(join(tmpdir(), "drishti-home-"));
    try {
      process.env.HOME = tmp;
      const home = daemonHome({ app: "drishti", placement: "state" });
      expect(home.dir).toContain("drishti");
      expect(home.file(HISTORY_RING_FILE)).toContain(HISTORY_RING_FILE);
      expect(home.socketPath).toContain(".sock");
      expect(home.artifacts.map((a) => a.id)).toEqual([
        "drishti-gate",
        "drishti-socket",
      ]);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
