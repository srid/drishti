// Client bundler — extracted so the Nix build derivation can invoke the
// same code path the dev server uses at startup. One implementation; two
// callers: `tsx src/server/build.ts <distDir>` from the Nix `buildPhase`,
// and `buildClient(distDir)` from the dev server when DRISHTI_DIST_DIR is
// unset.
//
// The bundle is driven by Vite: vite-plugin-solid for the Solid JSX transform,
// @tailwindcss/vite for the stylesheet, and @kolu/surface-app/vite's
// `surfaceApp()` for the freshness contract — the build commit published on the
// no-store shell as `window.__SURFACE_APP_COMMIT__` (kolu#1319, never a
// hashed-asset define). Vite owns the rest natively: content-hashed `/assets/*`
// and the index.html rewrite that names them. This replaced the hand-rolled
// `@kolu/surface-app/bun` (Bun.build) path.
//
// The config is built INLINE here rather than in a standalone vite.config.ts:
// drishti only ever bundles through this function (there is no `vite` CLI), and
// a config FILE would be loaded by Vite's config loader, which externalizes the
// bare `@kolu/surface-app/vite` import to Node — and Node refuses to strip types
// from a `.ts` under node_modules, which breaks the vitest `build.test.ts` path.
// Importing the plugins here keeps the whole config inside the caller's own
// transform pipeline (tsx in prod/Nix; vite-node's inline @kolu transform in
// tests), where the raw-.ts @kolu sources are handled.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeLogger } from "./log";

const log = makeLogger("build");

// packages/app/src/client — the Vite root (holds index.html + main.tsx).
const CLIENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "client");

export async function buildClient(distDir: string): Promise<void> {
  // Dynamic imports so the production server (DRISHTI_DIST_DIR set → prebuilt
  // dist, no build) never loads Vite and its plugin graph; only the dev-build
  // path and the Nix buildPhase pay for it.
  const { build } = await import("vite");
  const { default: solid } = await import("vite-plugin-solid");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const { surfaceApp } = await import("@kolu/surface-app/vite");
  await build({
    root: CLIENT_DIR,
    plugins: [solid(), tailwindcss(), surfaceApp()],
    // outDir is the dynamic destination (dev: the server's local dist; Nix
    // buildPhase: packages/app/dist). Vite content-hashes /assets/* and
    // rewrites index.html to name them under it.
    build: { target: "esnext", outDir: resolve(distDir), emptyOutDir: true },
  });
}

// CLI entrypoint: `tsx src/server/build.ts <distDir>` — used by the Nix build
// derivation's `buildPhase`. Skip when imported as a module (the dev server
// calls `buildClient` directly). `import.meta.main` is Bun-only; under Node
// (tsx) compare this module's URL to the invoked script.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const distDir = process.argv[2];
  if (!distDir) {
    log("usage: tsx src/server/build.ts <distDir>");
    process.exit(1);
  }
  await buildClient(resolve(distDir));
}
