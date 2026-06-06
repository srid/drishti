import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, APP_TITLE, titleForHost } from "./title";

describe("titleForHost", () => {
  it("names the selected host so the tab identifies the machine", () => {
    expect(titleForHost("user@host")).toBe("user@host — drishti");
    expect(titleForHost("localhost")).toBe("localhost — drishti");
  });

  it("falls back to the product title for the fleet overview (no host)", () => {
    expect(titleForHost(null)).toBe(APP_TITLE);
  });
});

// The product name appears verbatim in sites that can't import TypeScript:
// index.html (the pre-paint `<title>` and `apple-mobile-web-app-title`) and the
// static PWA manifest. These canaries pin every hand-authored copy to the
// `title.ts` constants — APP_TITLE (long form) and APP_NAME (short form) — so a
// rename that misses one fails here, mirroring brand.test.ts's color canaries.
describe("un-importable name sites stay in sync with the title constants", () => {
  const here = import.meta.dir;
  const read = (p: string) => readFileSync(join(here, p), "utf8");
  const html = read("index.html");
  const manifest = JSON.parse(read("public/manifest.webmanifest"));

  it("pins index.html's title (long) and apple app title (short)", () => {
    // The boot/SSR value before @solidjs/meta's reactive <Title> takes over.
    expect(html).toContain(`<title>${APP_TITLE}</title>`);
    expect(html).toContain(`content="${APP_NAME}"`); // apple-mobile-web-app-title
  });

  it("pins the manifest name (long) and short_name (short)", () => {
    expect(manifest.name).toBe(APP_TITLE);
    expect(manifest.short_name).toBe(APP_NAME);
  });
});
