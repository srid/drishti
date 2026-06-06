import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_DARK, BRAND_LIGHT } from "./brand";

// The brand colors have one canonical home (brand.ts). TypeScript sites import
// them directly (the icon generator; App.tsx's reactive `theme-color` <Meta>),
// so they can't drift. But styles.css and manifest.webmanifest can't import
// TypeScript, so they repeat the literals. This canary pins those un-importable
// sites to the constants — a rename that misses one fails here instead of
// silently shipping a mismatched theme color. Mirrors theme.test.ts pinning the
// THEME_KEY string. (index.html no longer carries a theme-color meta: App.tsx
// drives it reactively from the chosen theme, importing BRAND_* directly.)
describe("brand colors stay consistent across un-importable sites", () => {
  const here = import.meta.dir;
  const read = (p: string) => readFileSync(join(here, p), "utf8");
  const css = read("styles.css");
  const manifest = JSON.parse(read("public/manifest.webmanifest"));

  it("uses the dark color for the page background and the manifest", () => {
    expect(css).toContain(BRAND_DARK); // dark-theme page background
    expect(manifest.background_color).toBe(BRAND_DARK);
    expect(manifest.theme_color).toBe(BRAND_DARK);
  });

  it("uses the light color for the light-theme page background", () => {
    expect(css).toContain(BRAND_LIGHT); // light-theme page background
  });
});
