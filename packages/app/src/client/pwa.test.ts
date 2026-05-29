import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canRegisterServiceWorker } from "./pwa";

describe("canRegisterServiceWorker", () => {
  it("is true when the API exists and the context is secure", () => {
    expect(canRegisterServiceWorker({ serviceWorker: {} }, true)).toBe(true);
  });

  it("is false on an insecure context, even with the API present", () => {
    // plain-http LAN access — service workers are forbidden, so we skip
    // rather than throw on a registration that can't succeed.
    expect(canRegisterServiceWorker({ serviceWorker: {} }, false)).toBe(false);
  });

  it("is false when the navigator lacks serviceWorker", () => {
    expect(canRegisterServiceWorker({}, true)).toBe(false);
  });

  it("is false when there is no navigator at all", () => {
    expect(canRegisterServiceWorker(undefined, true)).toBe(false);
  });
});

describe("brand dark color stays single-valued", () => {
  // The dark page background #0b0d12 is repeated as the icon background
  // (gen-pwa-icons.ts), the manifest background/theme color, and the dark
  // theme-color meta — but `just gen-pwa-icons` only refreshes the icons, so
  // a color change can silently drift. This canary fails until every site
  // agrees, the same way theme.test.ts pins the THEME_KEY string.
  const here = import.meta.dir;
  const repoRoot = join(here, "..", "..", "..", "..");
  const read = (p: string) => readFileSync(p, "utf8");

  it("matches across styles.css, manifest, index.html, and the icon generator", () => {
    expect(read(join(here, "styles.css"))).toContain("#0b0d12");
    expect(read(join(here, "index.html"))).toContain('content="#0b0d12"');
    const manifest = JSON.parse(read(join(here, "public", "manifest.webmanifest")));
    expect(manifest.background_color).toBe("#0b0d12");
    expect(manifest.theme_color).toBe("#0b0d12");
    // the generator expresses the same color as RGB bytes
    expect(read(join(repoRoot, "scripts", "gen-pwa-icons.ts"))).toMatch(
      /0x0b,\s*0x0d,\s*0x12/,
    );
  });
});
