/**
 * NEGATIVE-PROPERTY PIN: nothing in this repo `await`s a member face.
 *
 * A unary verb on the Effect wire returns an `Effect`, and an `Effect` is a
 * DESCRIPTION — it dispatches nothing until something RUNS it. `await`ing one
 * compiles (an Effect is not thenable, and TypeScript does not error on a
 * non-thenable `await`), resolves WITH the Effect object, and never touches the
 * wire. The call silently does nothing and the caller reads a "success". That is
 * the shape that bit kolu nine times during the Effect campaign, including a
 * test that had quietly disabled the drain it existed to prove.
 *
 * drishti already states this rule in prose three times — `wire.ts`'s `runCall`
 * ("THE client's ONE run edge"), `dialDaemon.testlib.ts`'s `unary()`, and
 * `hostRegistry.ts`'s note that the drain is an Effect VALUE. Until now nothing
 * made it RED. The discipline held only because two well-written confinement
 * helpers existed and everyone used them; a newcomer reaching past them broke
 * nothing a test could see. This is the drishti twin of kolu's
 * `packages/tests/governance/awaitedFace.ts` (juspay/kolu#2101 B1), which grew
 * the alias and stored-description cases in the same review round this repo is
 * pinned to.
 *
 * ## Why a verbatim copy of kolu's scanner would pass VACUOUSLY here
 *
 * kolu's face pattern requires a literal `.surface.` / `.procedures.` segment in
 * the reference path, because that is how kolu spells a face. drishti does not:
 * its client reaches faces through FUNCTIONS — `hostRpc(host)`, `adminRpc()`,
 * `hostStreams(host)`, `hostCollections(host)` (`packages/app/src/client/wire.ts`).
 * So `await adminRpc().hosts.add({ host })` — the single most likely dodge in
 * this repo — scores CLEAN under kolu's regex. {@link ACCESSOR} is that gap
 * closed: a call to one of the four named accessors IS a face, wherever kolu
 * would have demanded the path segment. Copying the scanner without this would
 * have been worse than not copying it, because it would have looked guarded.
 *
 * ## The three shapes
 *
 * 1. **The direct await** — `await hostRpc(h).process.kill(x)`, or kolu's
 *    `await client.surface.ns.verb(x)`. The legitimate spellings survive because
 *    a run interposes a CALL whose parens NEST, which the path grammar cannot
 *    swallow: `await runCall(adminRpc().hosts.add(x))` does not match, and
 *    neither does `await Effect.runPromise(c.surface.control.core.hello())`.
 * 2. **The alias** — `const verb = adminRpc().hosts.add; await verb(x)`.
 * 3. **The stored description** — `const p = adminRpc().hosts.add(x); await p`.
 *    Indistinguishable from the alias at the binding, and neither may be awaited,
 *    so both are marked the same way: a name bound to anything that STARTS as a
 *    face is face-valued, and `await <that name>` is a hit.
 *
 * Plus the run-aliasing ban: `Effect.run*` NAMED but not CALLED (`const run =
 * Effect.runPromise`, `.then(Effect.runFork)`, `const { runPromise } = Effect`)
 * and a bare `import { runPromise } from "effect/Effect"`. An alias travels, so
 * each is banned outright rather than counted. drishti's own `runCall` is NOT
 * banned as an uncalled reference — it is a bare identifier, so its declaration
 * and every `import { runCall }` would be false positives; its confinement is
 * carried by clause 1 instead, which is what stops a call site from reaching
 * past it.
 *
 * ## Residual risk, stated so nobody mistakes this for a proof
 *
 * The marking is ONE hop and ONE file. `const a = adminRpc().hosts.add; const b
 * = a; await b(x)` escapes; so does an alias exported and awaited in another
 * module, and so does a face handed to a helper that awaits its own parameter. A
 * fifth accessor added to `wire.ts` is invisible until named here — which is the
 * cost of drishti spelling its faces as functions, and the reason the accessor
 * list sits next to a test that fails loudly rather than in a comment. A local
 * named `surface` or `procedures` that is NOT a face would be a false positive;
 * none exists, and the fix is to rename the local rather than soften the scan.
 * This raises the cost of the dodge; a determined dodger still has room.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Repo root — this file sits at `packages/app/src/`. It lives under `app` and
 *  NOT under `common` on purpose: `common` is copied whole into the agent's Nix
 *  fileset (`nix/packages/drishti-agent`), so a governance test parked there
 *  would rotate the agent BUILD_ID on every edit — and an accidental agent-drv
 *  change is a fleet-wide daemon restart. The scan is repo-wide either way. */
const ROOT = join(import.meta.dir, "..", "..", "..");
const PACKAGES = join(ROOT, "packages");

/** Nothing to police: dependencies and build output. Tests and `*.testlib.ts`
 *  ARE scanned — a test that silently never dispatches is the bug that hides all
 *  the others, which is precisely how kolu's disabled drain assertion survived. */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", ".vite"]);

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
/** kolu's face spelling: a literal `.surface.` / `.procedures.` path segment. */
const FACE = "(?:surface|procedures)";
/** drishti's face spelling: the four accessor FUNCTIONS in `wire.ts` that return
 *  a bound face. Adding one there without adding it here is the documented gap. */
const ACCESSOR = "(?:hostRpc|adminRpc|hostStreams|hostCollections)";
/** `.` or `?.`, with whitespace either side — a face path may wrap a line. */
const DOT = String.raw`\s*\??\.\s*`;
/** A reference path. Admits a CALL segment with NO nested parens, so
 *  `hostMap.entry(host).procedures` reads as one path — while
 *  `runCall(adminRpc().hosts.add(x))`, whose parens nest, cannot be read as one
 *  and so is not one. That asymmetry is what makes the whole scan possible. */
const REF = `${IDENT}(?:${DOT}${IDENT}|\\([^()]*\\))*`;

/** `await <path>.surface.<ns>.<verb>(` — kolu's shape. */
const AWAITED_FACE_CALL = new RegExp(
  `\\bawait\\s+${REF}${DOT}${FACE}${DOT}${IDENT}${DOT}${IDENT}\\s*\\(`,
  "g",
);

/** `await adminRpc().<ns>.<verb>(` — drishti's shape. The accessor call IS the
 *  face, so the namespace follows it directly with no `.procedures.` between. */
const AWAITED_ACCESSOR_CALL = new RegExp(
  `\\bawait\\s+${ACCESSOR}\\s*\\([^()]*\\)${DOT}${IDENT}${DOT}${IDENT}\\s*\\(`,
  "g",
);

/** `const <name> = <face>…` — the alias and the stored description alike, since
 *  both begin with a face and only the trailing `(x)` tells them apart. */
const FACE_BINDING = new RegExp(
  `\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*(?:${REF}${DOT}${FACE}\\b|${ACCESSOR}\\s*\\([^()]*\\))`,
  "g",
);

/** `const { verb } = adminRpc()` — every name it binds is face-valued. */
const FACE_DESTRUCTURE = new RegExp(
  `\\b(?:const|let|var)\\s*\\{([^{}]*)\\}\\s*=\\s*(?:${REF}${DOT}${FACE}\\b|${ACCESSOR}\\s*\\([^()]*\\))`,
  "g",
);

/** Any destructure — inspected for a binding NAMED `surface` or `procedures`,
 *  which is the face by its own framework name whatever the right hand side is. */
const ANY_DESTRUCTURE = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/g;

const AWAITED_NAME = new RegExp(`\\bawait\\s+(${IDENT})\\b`, "g");

/** `Effect.runPromise` NOT followed by `(` — the run-alias dodge. The `\b` before
 *  the lookahead matters: without it `runPromise` would match inside
 *  `runPromiseExit(` and report a real call as an alias. */
const UNCALLED_RUN_REFERENCE =
  /\b(?:Effect|Runtime|NodeRuntime)\s*\.\s*run[A-Z][A-Za-z]*\b(?!\s*\()/g;

/** `const { runPromise } = Effect` — the same dodge spelled as a destructure. */
const DESTRUCTURED_RUN =
  /\{[^{}]*\brun[A-Z][A-Za-z]*\b[^{}]*\}\s*=\s*(?:Effect|Runtime|NodeRuntime)\b/g;

/** A named import of a `run*` straight off an effect module — the one way a call
 *  site sheds the namespace {@link UNCALLED_RUN_REFERENCE} keys on. */
const BARE_RUN_IMPORT =
  /import\s*\{[^}]*\brun[A-Z][A-Za-z]*\b[^}]*\}\s*from\s*["']effect[^"']*["']/;

/**
 * Blank comments and string/template literals, replacing them with spaces so
 * every reported offset still lines up with the original source.
 *
 * A character scan rather than a regex: `//` inside a string literal and a quote
 * inside a comment both defeat the regex version, and this repo has both — this
 * very file NAMES every banned spelling in prose, and would otherwise report
 * itself. `keepStrings` exists for the import check, which has to READ a module
 * specifier: the one question about a source that a string literal is the answer
 * to rather than a hiding place.
 */
function blank(source: string, keepStrings: boolean): string {
  const out = source.split("");
  let i = 0;
  const blankTo = (end: number): void => {
    for (let j = i; j < end && j < out.length; j++)
      if (out[j] !== "\n") out[j] = " ";
    i = end;
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const nl = source.indexOf("\n", i);
      blankTo(nl === -1 ? source.length : nl);
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      blankTo(end === -1 ? source.length : end + 2);
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      // The quote characters themselves are ordinary code; only the contents go.
      i += 1;
      if (!keepStrings) blankTo(j - 1);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** The names a destructuring pattern binds: `{ a, b: c, ...rest }` → a, c, rest. */
function boundNames(pattern: string): string[] {
  const names: string[] = [];
  for (const part of pattern.split(",")) {
    const target = part.includes(":")
      ? (part.split(":").pop() ?? "")
      : part.replace("...", "");
    const name = new RegExp(`^\\s*(${IDENT})`).exec(target)?.[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

const lineOf = (code: string, index: number): number =>
  code.slice(0, index).split("\n").length;

export interface Hit {
  readonly line: number;
  readonly text: string;
}

/** Every `await`-on-a-face in `source`, direct or through a binding. */
export function findAwaitedFaces(source: string): Hit[] {
  const code = blank(source, false);
  const hits: Hit[] = [];
  const push = (index: number, text: string): void => {
    hits.push({ line: lineOf(code, index), text: text.replace(/\s+/g, " ").trim() });
  };

  for (const m of code.matchAll(AWAITED_FACE_CALL)) push(m.index, m[0]);
  for (const m of code.matchAll(AWAITED_ACCESSOR_CALL)) push(m.index, m[0]);

  /** Face-valued name → the line it was bound on, so a hit can cite it. */
  const faceBound = new Map<string, number>();
  const bind = (name: string, index: number): void => {
    if (name !== "" && !faceBound.has(name))
      faceBound.set(name, lineOf(code, index));
  };
  for (const m of code.matchAll(FACE_BINDING)) bind(m[1] ?? "", m.index);
  for (const m of code.matchAll(FACE_DESTRUCTURE))
    for (const name of boundNames(m[1] ?? "")) bind(name, m.index);
  for (const m of code.matchAll(ANY_DESTRUCTURE))
    for (const name of boundNames(m[1] ?? ""))
      if (name === "surface" || name === "procedures") bind(name, m.index);

  for (const m of code.matchAll(AWAITED_NAME)) {
    const name = m[1] ?? "";
    const boundAt = faceBound.get(name);
    if (boundAt === undefined) continue;
    push(m.index, `await ${name} — bound to a member face at line ${boundAt}`);
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Every place `source` NAMES a `run*` without calling it. Each is a violation in
 *  its own right rather than a counted edge: an alias travels, so there is no one
 *  file to hang a number on. */
export function findRunAliases(source: string): Hit[] {
  const code = blank(source, false);
  const hits: Hit[] = [];
  for (const re of [UNCALLED_RUN_REFERENCE, DESTRUCTURED_RUN])
    for (const m of code.matchAll(re))
      hits.push({
        line: lineOf(code, m.index),
        text: m[0].replace(/\s+/g, " ").trim(),
      });
  if (BARE_RUN_IMPORT.test(blank(source, true)))
    hits.push({ line: 0, text: "bare `run*` import off an effect module" });
  return hits.sort((a, b) => a.line - b.line);
}

/** Every `.ts`/`.tsx` file under `packages/` — tests and testlibs included. */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSources(full));
      continue;
    }
    if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function scanTree(find: (source: string) => Hit[]): string[] {
  const violations: string[] = [];
  for (const file of listSources(PACKAGES)) {
    const rel = relative(ROOT, file);
    // This file names every banned spelling, in prose AND as regex source. The
    // prose is blanked as comments; the patterns are string literals, also
    // blanked — but a regex built from them is neither, so exempt the scanner
    // from its own scan rather than contorting it to hide from itself.
    if (rel.endsWith("packages/app/src/awaitedFace.test.ts")) continue;
    for (const hit of find(readFileSync(file, "utf8")))
      violations.push(`${rel}:${hit.line}  ${hit.text}`);
  }
  return violations;
}

describe("awaited-face guard — a member call returns an Effect, so awaiting it yields the description and NEVER DISPATCHES (kolu#2101 B1)", () => {
  // A green scan and a scan that walked NOTHING are the same assertion. The
  // floor is what tells them apart: a broken root path throws, but a `packages/`
  // reorganised out from under this file would otherwise pass in silence.
  it("actually walks the tree — a vacuous scan is the failure mode this whole file exists to avoid", () => {
    expect(listSources(PACKAGES).length).toBeGreaterThan(100);
  });

  it("no file under packages/ awaits a member face — directly, through an accessor, or through a name bound to one", () => {
    expect(scanTree(findAwaitedFaces)).toEqual([]);
  });

  it("no file under packages/ names an `Effect.run*` without calling it — an alias would smuggle a run past every reader", () => {
    expect(scanTree(findRunAliases)).toEqual([]);
  });

  // ── The scanner's own falsifiability: each clause catches its dodge, and
  // each legitimate spelling survives. Without these, a regex that had silently
  // stopped matching would read exactly like a clean tree.
  describe("the scan is falsifiable", () => {
    it("catches the direct await, both face spellings", () => {
      expect(findAwaitedFaces("await client.surface.control.hello(x)")).toHaveLength(1);
      expect(findAwaitedFaces("await adminRpc().hosts.add({ host })")).toHaveLength(1);
      expect(findAwaitedFaces("await hostRpc(host).process.kill(input)")).toHaveLength(1);
    });

    it("catches the alias and the stored description", () => {
      expect(findAwaitedFaces("const add = adminRpc().hosts.add;\nawait add(x)")).toHaveLength(1);
      expect(findAwaitedFaces("const p = client.surface.ns.verb(x);\nawait p")).toHaveLength(1);
      expect(findAwaitedFaces("const { surface } = client;\nawait surface")).toHaveLength(1);
    });

    it("leaves the run edges alone — the nesting parens are what save them", () => {
      expect(findAwaitedFaces("await runCall(adminRpc().hosts.add({ host }))")).toEqual([]);
      expect(findAwaitedFaces("await Effect.runPromise(c.surface.control.core.hello())")).toEqual([]);
      expect(findAwaitedFaces("yield* client.surface.ns.verb(x)")).toEqual([]);
    });

    it("catches a run named but not called, and leaves a real call alone", () => {
      expect(findRunAliases("const run = Effect.runPromise;")).toHaveLength(1);
      expect(findRunAliases("const { runFork } = Effect;")).toHaveLength(1);
      expect(findRunAliases('import { runPromise } from "effect/Effect";')).toHaveLength(1);
      expect(findRunAliases("Effect.runPromise(p); Effect.runPromiseExit(p);")).toEqual([]);
    });

    it("does not see a banned spelling quoted in prose or in a string", () => {
      expect(findAwaitedFaces("// await client.surface.ns.verb(x)")).toEqual([]);
      expect(findRunAliases('const msg = "use Effect.runPromise instead";')).toEqual([]);
    });
  });
});
