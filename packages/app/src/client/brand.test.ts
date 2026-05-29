import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_DARK, BRAND_LIGHT } from "./brand";

// The brand colors have one canonical home (brand.ts). The icon generator
// imports them, so the icons can't drift. But styles.css, index.html, and
// manifest.webmanifest can't import TypeScript, so they repeat the literals.
// This canary pins those hand-authored sites to the constants — a rename
// that misses one fails here instead of silently shipping a mismatched
// theme color. Mirrors theme.test.ts pinning the THEME_KEY string.
describe("brand colors stay consistent across un-importable sites", () => {
  const here = import.meta.dir;
  const read = (p: string) => readFileSync(join(here, p), "utf8");
  const css = read("styles.css");
  const html = read("index.html");
  const manifest = JSON.parse(read("public/manifest.webmanifest"));

  it("uses the dark color for both theme surfaces and the manifest", () => {
    expect(css).toContain(BRAND_DARK); // dark-theme page background
    expect(html).toContain(`content="${BRAND_DARK}"`); // dark theme-color meta
    expect(manifest.background_color).toBe(BRAND_DARK);
    expect(manifest.theme_color).toBe(BRAND_DARK);
  });

  it("uses the light color for the light-theme surfaces", () => {
    expect(css).toContain(BRAND_LIGHT); // light-theme page background
    expect(html).toContain(`content="${BRAND_LIGHT}"`); // light theme-color meta
  });
});
