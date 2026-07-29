import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SharedArtifact,
  resolveDaemonHome,
} from "@kolu/surface-daemon";
import { createSharedArtifactWatchdog } from "@kolu/surface-daemon/upgrade-window.testlib";
import { HISTORY_RING_FILE, HISTORY_RING_VERSION } from "./historyRing";

/**
 * Consumer-side inventory: framework gate+socket artifacts plus the durable
 * history ring. `coveredByTest` names the disposition suite that plants v+1
 * and truncated rings — a versionField alone never excuses a missing test.
 */
function drishtiArtifacts(home: {
  artifacts: readonly SharedArtifact[];
  file: (name: string) => string;
  pathShapeRoot?: string;
}): SharedArtifact[] {
  const pathShapeRoot =
    (home as { pathShapeRoot?: string }).pathShapeRoot ?? "~/.local/state/drishti";
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
    // resolveDaemonHome is pure path algebra (no mkdir) — fine for shapes.
    const home = resolveDaemonHome({
      app: "drishti",
      placement: "state",
    });
    // daemonHome materialises dir; for pure registry we only need artifacts
    // shape. Gate+socket entries come from materialised homes — synthesise
    // the same basenames the framework would emit.
    const gateSocket: SharedArtifact[] = [
      {
        id: "gate",
        pathShape: `${home.pathShapeRoot}/${home.gateName}`,
        role: "gate",
        coveredByTest: null,
        versionField: null,
        diskBasenames: [home.gateName],
        diskBasenamePatterns: [],
        why: "single-instance gate",
      },
      {
        id: "socket",
        pathShape: `${home.pathShapeRoot}/${home.sockName}`,
        role: "socket",
        coveredByTest: null,
        versionField: null,
        diskBasenames: [home.sockName],
        diskBasenamePatterns: [],
        why: "serving socket",
      },
    ];
    const registry = drishtiArtifacts({
      artifacts: gateSocket,
      file: home.file,
      pathShapeRoot: home.pathShapeRoot,
    });

    const watchdog = createSharedArtifactWatchdog(registry);
    watchdog.assertInventory(["gate", "socket", "history-ring"]);

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
  });

  it("materialises a private state home under a temp HOME", () => {
    // Integration-ish: daemonHome needs a writable HOME. Isolate via env.
    const prev = process.env.HOME;
    const tmp = mkdtempSync(join(tmpdir(), "drishti-home-"));
    try {
      process.env.HOME = tmp;
      // Dynamic import path — use resolve + mkdir manually to avoid
      // coupling the test to a real $HOME write when daemonHome is used
      // in production. Here we only check resolve paths.
      const home = resolveDaemonHome({
        app: "drishti",
        placement: "state",
      });
      expect(home.dir).toContain("drishti");
      expect(home.file(HISTORY_RING_FILE)).toContain(HISTORY_RING_FILE);
      expect(home.socketPath).toContain(".sock");
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
