import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { otherTheme, parseTheme, THEME_KEY } from "./theme";

describe("parseTheme", () => {
  it("accepts the two known themes", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
  });

  it("rejects absent, empty, or unknown values", () => {
    expect(parseTheme(null)).toBeNull();
    expect(parseTheme("")).toBeNull();
    expect(parseTheme("Dark")).toBeNull();
    expect(parseTheme("system")).toBeNull();
  });
});

describe("otherTheme", () => {
  it("flips between the two themes", () => {
    expect(otherTheme("dark")).toBe("light");
    expect(otherTheme("light")).toBe("dark");
  });
});

describe("THEME_KEY", () => {
  it("matches the literal hardcoded in index.html's pre-paint bootstrap", () => {
    // The inline script runs before any module loads, so it can't import
    // THEME_KEY — this canary fails if the constant is renamed without
    // updating index.html in lockstep (the one duplication that can't be
    // collapsed away).
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "index.html"),
      "utf8",
    );
    expect(html).toContain(`"${THEME_KEY}"`);
  });
});
