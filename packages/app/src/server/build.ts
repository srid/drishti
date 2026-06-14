// Client bundler — extracted so the Nix build derivation can invoke the
// same code path the dev server uses at startup. One implementation; two
// callers: `tsx src/server/build.ts <distDir>` from the Nix `buildPhase`,
// and `buildClient(distDir)` from the dev server when DRISHTI_DIST_DIR is
// unset.
//
// The bundle is driven by Vite (packages/app/vite.config.ts): vite-plugin-solid
// for the Solid JSX transform, @tailwindcss/vite for the stylesheet, and
// @kolu/surface-app/vite's `surfaceApp()` for the freshness contract — the
// build commit published on the no-store shell as `window.__SURFACE_APP_COMMIT__`
// (kolu#1319, never a hashed-asset define). Vite owns the rest of the contract
// natively: content-hashed `/assets/*` and the index.html rewrite that names
// them. This replaced the hand-rolled `@kolu/surface-app/bun` (Bun.build) path.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeLogger } from "./log";

const log = makeLogger("build");

// packages/app — this file is at packages/app/src/server/build.ts, so two
// levels up from src/server is the package root where vite.config.ts lives.
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function buildClient(distDir: string): Promise<void> {
  // Dynamic import so the production server (DRISHTI_DIST_DIR set → prebuilt
  // dist, no build) never loads Vite and its plugin graph; only the dev-build
  // path and the Nix buildPhase pay for it.
  const { build } = await import("vite");
  await build({
    // The config file owns root (src/client) and the plugin set; we override
    // only the dynamic outDir (dev: the server's local dist; Nix: packages/app/dist).
    configFile: resolve(APP_DIR, "vite.config.ts"),
    build: { outDir: resolve(distDir), emptyOutDir: true },
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
