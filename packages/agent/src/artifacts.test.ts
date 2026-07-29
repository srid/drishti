import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SharedArtifact,
  daemonHome,
} from "@kolu/surface-daemon";
import {
  createSharedArtifactWatchdog,
  executeVersionDispositionProof,
} from "@kolu/surface-daemon/upgrade-window.testlib";
import {
  HISTORY_RING_FILE,
  HISTORY_RING_VERSION,
  loadHistoryRing,
} from "./historyRing";

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
      // versionField non-null requires a declared version+1 reader outcome
      // (UW2 final SharedArtifact). loadHistoryRing returns kind "unavailable"
      // for unknown-v (reason "unknown-version"); that kind is the disposition.
      versionField: "v",
      versionDisposition: "unavailable",
      diskBasenames: [HISTORY_RING_FILE],
      diskBasenamePatterns: [/^history\.ring\.json\.corrupt-\d+$/],
      why: "metric history survives parent deploys and reconnects; typed unavailable on corrupt/unknown-version",
    },
  ];
}

describe("drishti shared-artifact registry", () => {
  it("registers gate, socket, and history ring with disposition coverage", async () => {
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

      const ring = registry.find((a) => a.id === "history-ring");
      if (ring === undefined) throw new Error("history-ring missing");
      expect(ring.versionField).toBe("v");
      if (ring.versionField === null) throw new Error("history-ring must be versioned");
      expect(ring.versionDisposition).toBe("unavailable");
      expect(ring.coveredByTest).toBe("historyRing.test.ts");
      expect(HISTORY_RING_VERSION).toBe(1);

      // UW2 final: versionField requires executed plant → readback → observe
      // that RETURNS the declared versionDisposition kind (not void).
      const ringPath = home.file(HISTORY_RING_FILE);
      const newerVersion = HISTORY_RING_VERSION + 1;
      const versionProof = await executeVersionDispositionProof({
        artifact: ring,
        newerVersion: String(newerVersion),
        plant: () => {
          writeFileSync(
            ringPath,
            JSON.stringify({
              v: newerVersion,
              samples: [{ t: 1, cpu: 0, mem: 0, swap: 0, disk: 0 }],
            }),
          );
        },
        readPlantedVersion: () => {
          const parsed = JSON.parse(readFileSync(ringPath, "utf8")) as {
            v: number;
          };
          return String(parsed.v);
        },
        observeDisposition: () => {
          const loaded = loadHistoryRing(ringPath);
          // Must RETURN the disposition object whose `.kind` matches
          // versionDisposition ("unavailable"); reason pins unknown-version.
          expect(loaded.kind).toBe("unavailable");
          if (loaded.kind === "unavailable") {
            expect(loaded.reason).toBe("unknown-version");
          }
          // Unknown version leaves the file alone.
          expect(readFileSync(ringPath, "utf8")).toContain(
            `"v":${newerVersion}`,
          );
          return loaded;
        },
      });

      const watchdog = createSharedArtifactWatchdog(registry);
      watchdog.assertInventory(["drishti-gate", "drishti-socket", "history-ring"]);

      const gaps = watchdog.coverageGaps(
        new Set(["historyRing.test.ts", "artifacts.test.ts"]),
        [versionProof],
      );
      expect(
        gaps.filter((g) => g.startsWith("history-ring")),
      ).toEqual([]);
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
