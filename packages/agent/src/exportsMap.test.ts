/**
 * W8.3: package.json exports map encapsulates internal modules.
 * Deep import of runtime.ts from outside the package must not resolve
 * via the package name; the fixture keeps a relative import in-repo.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("drishti-agent package exports (W8.3)", () => {
  it("runtime.ts exists for in-repo relative imports", () => {
    expect(existsSync(join(import.meta.dir, "runtime.ts"))).toBe(true);
  });

  it("package name deep-import of src/runtime is not exported", async () => {
    // Under package exports, `drishti-agent/src/runtime` must not resolve.
    // Bun honors exports for package-name imports.
    let err: unknown = null;
    try {
      // @ts-expect-error W8.3: deep path not in package exports
      await import("drishti-agent/src/runtime");
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    // Relative import of the same file still works (this package).
    const rel = await import("./runtime");
    expect(typeof rel.buildAgentRuntime).toBe("function");
  });

  it("package.json exports only . and package.json", async () => {
    const pkg = (await import("../package.json", {
      with: { type: "json" },
    })) as { default: { exports: Record<string, string> } };
    const exports = pkg.default.exports;
    expect(Object.keys(exports).sort()).toEqual([".", "./package.json"]);
    expect(exports["."]).toBe("./src/main.ts");
  });
});
