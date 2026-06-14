import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, APP_TITLE, appNameForHost } from "./title";

describe("appNameForHost", () => {
  it("names the server's own host so each deployment is a distinct app", () => {
    expect(appNameForHost("zest")).toBe("drishti@zest");
    expect(appNameForHost("rasam.tail12b27.ts.net")).toBe(
      "drishti@rasam.tail12b27.ts.net",
    );
  });
});

// The product name appears verbatim in sites that can't import TypeScript:
// `apple-mobile-web-app-title` in index.html and the static PWA manifest. These
// canaries pin the hand-authored copies to the `title.ts` constants so a rename
// that misses one fails here, mirroring brand.test.ts's color canaries. (There
// is no static `<title>` to canary — @solidjs/meta owns the document title; see
// index.html. The served runtime manifest is host-scoped — `drishti@<host>`,
// formed from APP_NAME via appNameForHost — so only the static placeholder
// manifest, which keeps the bare brand, is pinned here.)
describe("un-importable name sites stay in sync with the title constants", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (p: string) => readFileSync(join(here, p), "utf8");
  const html = read("index.html");
  const manifest = JSON.parse(read("public/manifest.webmanifest"));

  it("pins the apple-mobile-web-app-title to APP_NAME", () => {
    expect(html).toContain(`content="${APP_NAME}"`);
  });

  it("pins the static placeholder manifest name/short_name", () => {
    expect(manifest.name).toBe(APP_TITLE);
    expect(manifest.short_name).toBe(APP_NAME);
  });
});
