/**
 * W8.3: package.json exports map encapsulates internal modules.
 * Deep import of runtime.ts from outside the package must not resolve
 * via the package name; the fixture keeps a relative import in-repo.
 */
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("drishti-agent package exports (W8.3)", () => {
  it("runtime.ts exists for in-repo relative imports", () => {
    expect(existsSync(join(import.meta.dir, "runtime.ts"))).toBe(true);
  });

  it("package.json exports only . and package.json", async () => {
    const pkg = (await import("../package.json", {
      with: { type: "json" },
    })) as { default: { exports: Record<string, string> } };
    const exports = pkg.default.exports;
    expect(exports).toBeDefined();
    expect(Object.keys(exports).sort()).toEqual([".", "./package.json"]);
    expect(exports["."]).toBe("./src/main.ts");
    // No deep path for runtime or fixtures (encapsulation).
    expect(exports["./src/runtime"]).toBeUndefined();
    expect(exports["./src/runtime.ts"]).toBeUndefined();
    expect(exports["./src/*"]).toBeUndefined();
  });

  it("package-name deep path of src/runtime is not resolvable", () => {
    // Node package resolution: with exports present, deep path is denied
    // (ERR_PACKAGE_PATH_NOT_EXPORTED or MODULE_NOT_FOUND depending on linker).
    // Mutation: delete exports field ⇒ require.resolve succeeds (err null).
    const require = createRequire(import.meta.url);
    let err: unknown = null;
    try {
      require.resolve("drishti-agent/src/runtime");
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();

    // Relative import of the same file still works (this package).
    const rel = require("./runtime") as { buildAgentRuntime: unknown };
    expect(typeof rel.buildAgentRuntime).toBe("function");
  });
});
