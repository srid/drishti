import { resolve } from "node:path";
import { surfaceApp } from "@kolu/surface-app/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The drishti browser client. Mirrors the kolu surface "remote-process-monitor"
// example (solid + tailwind), plus `surfaceApp()` for the freshness contract.
//
//   - `solid()`        — the Solid JSX transform (compiled-template runtime), the
//                        same transform the old Bun build wired up by hand via
//                        babel-preset-solid; vite-plugin-solid carries its own babel.
//   - `tailwindcss()`  — Tailwind v4, replacing the old `@tailwindcss/cli` shell-out.
//                        Processes `@import "tailwindcss"` in styles.css (referenced
//                        from index.html) into a hashed `/assets/styles-<hash>.css`.
//   - `surfaceApp()`   — publishes the build commit on the `no-store` shell as
//                        `window.__SURFACE_APP_COMMIT__` (SURFACE_APP_COMMIT env →
//                        git → "dev"), read back by `shellCommit()`. NEVER a bundler
//                        define (kolu#1319). The same commit the server cell reads,
//                        and the one the Nix buildPhase stamps via SURFACE_APP_COMMIT.
//
// Vite natively content-hashes `/assets/*` and rewrites index.html to name them —
// the immutable-caching half of the freshness contract that `@kolu/surface-app/bun`'s
// `buildSurfaceClient` used to own for the Bun path. `src/client/public/` (icons,
// manifest fixture) is copied verbatim to the dist root by Vite's default publicDir.
//
// `outDir` is injected per-call by `src/server/build.ts` (dev: the server's local
// dist; Nix buildPhase: packages/app/dist) — both go through the one `buildClient`.
export default defineConfig({
  // Absolute so the build resolves the entry HTML regardless of the cwd it's
  // invoked from — `buildClient` (src/server/build.ts) drives `vite build`
  // programmatically with the Nix buildPhase's cwd at the repo root, not here.
  // Vite injects this config file's real directory for `import.meta.dirname`.
  root: resolve(import.meta.dirname, "src/client"),
  plugins: [solid(), tailwindcss(), surfaceApp()],
  build: {
    target: "esnext",
    emptyOutDir: true,
  },
});
