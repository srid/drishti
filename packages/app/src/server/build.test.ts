import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClient } from "./build";

// The build is the only place the PWA assets get wired together (manifest +
// icons copied from public/, service-worker registration bundled into
// main.js, head tags carried through index.html). These tests run the real
// build once and assert the whole PWA surface lands in dist — the thing that
// actually breaks if the public/ copy or the head wiring regresses.

const dist = mkdtempSync(join(tmpdir(), "drishti-dist-"));

beforeAll(async () => {
  await buildClient(dist);
}, 120_000);

const read = (rel: string) => readFileSync(join(dist, rel), "utf8");
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe("buildClient — PWA assets", () => {
  it("ships a valid web manifest with installable fields and icons", () => {
    const manifest = JSON.parse(read("manifest.webmanifest"));
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(
      manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable"),
    ).toBe(true);
  });

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

  it("ships the service worker with offline-shell caching", () => {
    const sw = read("sw.js");
    expect(sw).toContain('addEventListener("install"');
    expect(sw).toContain('addEventListener("fetch"');
    expect(sw).toContain("drishti-shell");
  });

  it("bundles the service-worker registration into main.js", () => {
    expect(read("main.js")).toContain("/sw.js");
  });

  it("wires the manifest, theme-color, and icons into index.html", () => {
    const html = read("index.html");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('rel="apple-touch-icon"');
    // the entry script is rewritten from the source .tsx to the built .js
    expect(html).toContain('src="./main.js"');
  });
});

// Best-effort cleanup; the OS temp dir is reclaimed regardless.
process.on("exit", () => rmSync(dist, { recursive: true, force: true }));
