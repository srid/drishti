import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClient } from "./build";

// The build wires together the client bundle and the static PWA assets:
// content-hashed JS+CSS under /assets/ (surface-app's immutable-caching
// prerequisite), the icons copied from public/ at the dist root, and an
// index.html shell rewritten to reference the hashed asset URLs. These tests
// run the real build once and assert that whole surface lands in dist — the
// thing that actually breaks if the public/ copy or the asset wiring regresses.
//
// NB: drishti no longer ships its own caching service worker, and the manifest
// is served DYNAMICALLY by `installSurfaceApp` (installPwaManifest) at runtime
// — neither is in the built dist, so neither is asserted here. The retirement
// `/sw.js` is the server's responsibility (SW_SOURCE), covered by surface-app.

const dist = mkdtempSync(join(tmpdir(), "drishti-dist-"));

beforeAll(async () => {
  await buildClient(dist);
}, 120_000);

const read = (rel: string) => readFileSync(join(dist, rel), "utf8");
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe("buildClient — hashed assets (immutable-caching prerequisite)", () => {
  it("emits a content-hashed JS bundle under /assets/", () => {
    const assets = readdirSync(join(dist, "assets"));
    const js = assets.filter((f) => /^main-[A-Za-z0-9]+\.js$/.test(f));
    expect(js.length).toBe(1);
  });

  it("emits a content-hashed CSS file under /assets/", () => {
    const assets = readdirSync(join(dist, "assets"));
    const css = assets.filter((f) => /^styles-[A-Za-z0-9]+\.css$/.test(f));
    expect(css.length).toBe(1);
  });

  it("rewrites index.html to reference the hashed /assets/ URLs", () => {
    const html = read("index.html");
    // the entry script and stylesheet now point at hashed /assets/ paths,
    // never the source .tsx or the old root-level ./styles.css
    expect(html).toMatch(/src="\/assets\/main-[A-Za-z0-9]+\.js"/);
    expect(html).toMatch(/href="\/assets\/styles-[A-Za-z0-9]+\.css"/);
    expect(html).not.toContain("main.tsx");
    expect(html).not.toContain('href="./styles.css"');
  });

  it("ships no service worker (retirement worker is server-served)", () => {
    const assets = readdirSync(dist);
    expect(assets).not.toContain("sw.js");
  });
});

describe("buildClient — static PWA assets at the dist root", () => {
  it("copies every referenced icon, each a well-formed file", () => {
    for (const png of [
      "icons/icon-192.png",
      "icons/icon-512.png",
      "icons/icon-maskable-512.png",
      "icons/apple-touch-icon.png",
    ]) {
      const bytes = readFileSync(join(dist, png));
      expect(bytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    }
    expect(read("icons/icon.svg").trimStart()).toStartWith("<svg");
  });

  it("wires the manifest link, theme-color, and icons into index.html", () => {
    const html = read("index.html");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('rel="apple-touch-icon"');
  });
});

// Best-effort cleanup; the OS temp dir is reclaimed regardless.
process.on("exit", () => rmSync(dist, { recursive: true, force: true }));
