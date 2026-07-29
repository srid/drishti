/**
 * W2.5 outer agent stamp: BUILD_ID (identity) + COMMIT_HASH (navigable rev).
 *
 * Joint invariant: a nix-built agent with non-empty BUILD_ID must stamp a
 * non-empty COMMIT_HASH. Mutation: drop --set DRISHTI_AGENT_COMMIT_HASH from
 * the outer makeWrapper in default.nix ⇒ this pin reds.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const defaultNix = readFileSync(
  join(import.meta.dir, "../../../../default.nix"),
  "utf8",
);

describe("agent outer wrapper identity stamp (default.nix)", () => {
  it("outer makeWrapper stamps BUILD_ID and COMMIT_HASH (joint invariant)", () => {
    // Outer agent block: from `drishti-agent =` through its closing `';`.
    // (Not the monitor `drishti =` block which also stamps COMMIT_HASH.)
    const start = defaultNix.indexOf(
      'drishti-agent = resolvedPkgs.runCommand "drishti-agent"',
    );
    expect(start).toBeGreaterThan(-1);
    const end = defaultNix.indexOf("drishti-client =", start);
    expect(end).toBeGreaterThan(start);
    const block = defaultNix.slice(start, end);
    expect(block).toMatch(/DRISHTI_AGENT_BUILD_ID/);
    // MUTATION: remove this --set line ⇒ red.
    expect(block).toMatch(/--set DRISHTI_AGENT_COMMIT_HASH "\$\{rev\}"/);
    // Comment documents zero identity cost of outer rev stamp.
    expect(defaultNix).toMatch(/ZERO identity cost|zero identity cost/i);
  });

  it("BUILD_ID derives from inner only (not monorepo rev)", () => {
    expect(defaultNix).toMatch(
      /drishtiAgentBuildId = builtins\.hashString "sha256" \(toString drishti-agent-inner\)/,
    );
    // Inner wrapper must not carry COMMIT_HASH / monorepo rev.
    const start = defaultNix.indexOf(
      'drishti-agent-inner = resolvedPkgs.runCommand "drishti-agent-inner"',
    );
    const end = defaultNix.indexOf("drishtiAgentBuildId =", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const inner = defaultNix.slice(start, end);
    expect(inner).not.toMatch(/DRISHTI_AGENT_COMMIT_HASH/);
    expect(inner).not.toMatch(/\$\{rev\}/);
  });
});
