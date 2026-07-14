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
 *   - any `ContractRouterClient<typeof …>` alias — a contract-wide client-shape copy
 *     (procedures included), whether it names a `…Surface.contract` or a bare
 *     `…Contract`. The combined link is typed by `connectSurfaces`' generics, not a
 *     hand-rolled alias, so nothing legitimate trips this.
 * A bare `.rpc` read stays fine (reserved `system.*` procs + the escape hatch).
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
const CONTRACT_CLIENT_COPY_RE = /ContractRouterClient<\s*typeof\s/;

function findViolations(): string[] {
  const violations: string[] = [];
  for (const file of listSourceFiles(CLIENT_DIR)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const rel = `${file.replace(`${CLIENT_DIR}/`, "")}:${i + 1}`;
      if (RPC_CAST_RE.test(line))
        violations.push(`${rel} — .rpc cast: ${line.trim()}`);
      if (CONTRACT_CLIENT_COPY_RE.test(line))
        violations.push(`${rel} — copied procedure shape: ${line.trim()}`);
    }
  }
  return violations;
}

describe("procedure cast guard — no declared Surface procedure is reached by casting `.rpc` or copied as a client-shape alias (kolu Surface PR 2)", () => {
  it("packages/app/src/client has no `.rpc as <T>` cast and no `ContractRouterClient<typeof …>` alias — declared procedures ride the bound `procedures` face", () => {
    expect(findViolations()).toEqual([]);
  });
});
