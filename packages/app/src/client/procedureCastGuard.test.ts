/**
 * NEGATIVE-PROPERTY PIN (kolu Surface plan PR 2 — procedures join the typed dual):
 * no drishti client consumer CASTS a declared Surface procedure client or COPIES its
 * callable client shape. Every declared procedure now rides the bound `procedures`
 * face — `hostRpc(host) = hostMap.entry(host).procedures` and `adminRpc() =
 * clients.admin.procedures`, typed straight from the declaration — so the old
 * `HostRpc = ContractRouterClient<typeof browserSurface.contract>` /
 * `AdminScopedRpc = { surface: ContractRouterClient<typeof adminContract>… }` aliases
 * and their `... .rpc as …` casts are gone. This is the drishti twin of kolu's own
 * `procedureCastGuard.test.ts`: kolu's vitest cannot see this tree, and an unpinned
 * half is where the cast class re-enters.
 *
 * Forbidden in `packages/app/src/client`:
 *   - a `.rpc as <T>` cast — reaching a declared procedure through the raw client;
 *   - a `SurfaceFace` alias over a member reach — the Effect-epoch successor to the
 *     deleted `ContractRouterClient<typeof …>` clause.
 *
 * ## Why the second clause was REWRITTEN, not deleted
 *
 * `ContractRouterClient` was oRPC's "give me the whole contract's client shape as a
 * type" — the exact tool a consumer reached for when it wanted to hand-roll a
 * procedure client instead of using the bound `procedures` face. That type no longer
 * exists, so a rule naming it would be vacuous: it would pass forever and pin
 * nothing. The class of mistake did not go away with the type, though. Its Effect
 * spelling is `SurfaceFace` — the deliberately STRUCTURAL addressing layer whose
 * members are `unknown` — so annotating a member reach with it is how a consumer
 * re-acquires the "I typed this by hand" habit, and how a real drift (a cast, a
 * narrowing, a shape copy) would re-enter.
 *
 * A bare `.rpc` read stays fine (reserved `system.*` probes + the escape hatch), and
 * so does importing `SurfaceFace` as a TYPE for something that genuinely is one — the
 * rule bites only when the name is used to type a member reach.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIR = import.meta.dir; // packages/app/src/client

/** Every non-test `.ts`/`.tsx` source file under a directory. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(full) || /\.test(-d)?\.tsx?$/.test(full)) continue;
    out.push(full);
  }
  return out;
}

const RPC_CAST_RE = /\.rpc\s+as\s+\w/;
/** A member reach annotated with the erased addressing layer — `const x:
 *  SurfaceFace = …` or `… as SurfaceFace`. The Effect successor of the deleted
 *  `ContractRouterClient<typeof …>` clause (see the module docstring). */
const FACE_ALIAS_RE = /(?::\s*SurfaceFace\b|\bas\s+SurfaceFace\b)/;

function findViolations(): string[] {
  const violations: string[] = [];
  for (const file of listSourceFiles(CLIENT_DIR)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const rel = `${file.replace(`${CLIENT_DIR}/`, "")}:${i + 1}`;
      if (RPC_CAST_RE.test(line))
        violations.push(`${rel} — .rpc cast: ${line.trim()}`);
      if (FACE_ALIAS_RE.test(line))
        violations.push(`${rel} — hand-typed member reach: ${line.trim()}`);
    }
  }
  return violations;
}

describe("procedure cast guard — no declared Surface procedure is reached by casting `.rpc` or copied as a client-shape alias (kolu Surface PR 2)", () => {
  it("packages/app/src/client has no `.rpc as <T>` cast and no hand-typed `SurfaceFace` member reach — declared procedures ride the bound `procedures` face", () => {
    expect(findViolations()).toEqual([]);
  });
});
