import { describe, expect, it } from "bun:test";
import { prefKey } from "./localStorageState";

describe("prefKey", () => {
  it("namespaces a preference under the host", () => {
    expect(prefKey("sort", "localhost")).toBe("drishti:sort:localhost");
  });

  it("keeps ssh targets verbatim so each host gets its own slot", () => {
    expect(prefKey("window", "user@a.lan")).toBe("drishti:window:user@a.lan");
    expect(prefKey("window", "[::1]")).toBe("drishti:window:[::1]");
  });

  it("distinguishes prefs and hosts so keys never collide", () => {
    const keys = [
      prefKey("sort", "a"),
      prefKey("sort", "b"),
      prefKey("filter", "a"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
