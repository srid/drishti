import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("buildClient — offline shell is complete", () => {
  // The service worker precaches a hand-maintained SHELL list. If an icon is
  // referenced (by the manifest or index.html) but missing from SHELL, the
  // installed app shows a broken image offline; if a SHELL entry doesn't
  // exist in dist, install fails to cache it. Both are silent without this.
  const shellURLs = (): string[] => {
    const body = read("sw.js").match(/SHELL = \[([\s\S]*?)\]/)?.[1] ?? "";
    return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
  };
  const referencedIcons = (): Set<string> => {
    const manifest = JSON.parse(read("manifest.webmanifest"));
    const fromManifest: string[] = manifest.icons
      .map((i: { src: string }) => i.src)
      .filter((src: string) => src.startsWith("/icons/"));
    const fromHtml = [...read("index.html").matchAll(/href="(\/icons\/[^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    return new Set([...fromManifest, ...fromHtml]);
  };

  it("precaches every icon the manifest and index.html reference", () => {
    const urls = shellURLs();
    // Guard against a restructured SHELL the regex can't parse — an empty
    // list would make both this and the existence loop pass vacuously.
    expect(urls.length).toBeGreaterThan(0);
    const shell = new Set(urls);
    for (const icon of referencedIcons()) expect(shell.has(icon)).toBe(true);
  });

  it("precaches only assets that exist in the built bundle", () => {
    for (const url of shellURLs()) {
      const rel = url === "/" ? "index.html" : url.replace(/^\//, "");
      expect(existsSync(join(dist, rel))).toBe(true);
    }
  });
});

// Best-effort cleanup; the OS temp dir is reclaimed regardless.
process.on("exit", () => rmSync(dist, { recursive: true, force: true }));
