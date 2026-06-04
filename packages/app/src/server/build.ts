// Client bundler — extracted so the Nix build derivation can invoke the
// same code path the dev server uses at startup. One implementation; two
// callers: `bun build.ts <distDir>` from the Nix `buildPhase`, and
// `buildClient(distDir)` from the dev server when DRISHTI_DIST_DIR is
// unset.
//
// Bun.serve's HTML-import bundler does not honor plugins registered
// through bunfig preload — `babel-preset-solid`'s JSX transform never
// fires there, and Bun's default JSX transform emits `React.createElement`
// calls that break at runtime. Bun.build accepts a `plugins` array
// directly, so we drive the build ourselves.
//
// The freshness contract — content-hashed `/assets/*` naming, the
// `__SURFACE_APP_COMMIT__` define, the no-store shell rewrite, the public
// copy — is owned by `@kolu/surface-app/bun`'s `buildSurfaceClient`. This
// file *composes* it, supplying only what is genuinely drishti's own: the
// Solid JSX plugin and the Tailwind CSS toolchain.

import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
// @ts-expect-error - babel preset types are loose
import babelTypeScript from "@babel/preset-typescript";
// @ts-expect-error - babel preset types are loose
import babelSolid from "babel-preset-solid";
import type { BunPlugin } from "bun";
import { buildSurfaceClient } from "@kolu/surface-app/bun";
import { makeLogger } from "./log";

const log = makeLogger("build");

// Solid JSX transform. babel-preset-solid emits the compiled-template
// runtime (template/insert/createComponent) so signals drive DOM updates;
// the typescript preset strips type annotations first.
const solidJsxPlugin: BunPlugin = {
  name: "drishti-solid",
  setup(build) {
    build.onLoad({ filter: /\.(?:js|ts)x$/ }, async (args) => {
      const code = await Bun.file(args.path).text();
      const result = await transformAsync(code, {
        filename: args.path,
        presets: [
          [babelSolid, {}],
          [babelTypeScript, {}],
        ],
      });
      if (!result?.code)
        throw new Error(`Babel transform produced no output for ${args.path}`);
      return { contents: result.code, loader: "js" };
    });
  },
};

const CLIENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "client");

// Tailwind v4 CSS — produce the stylesheet bytes for buildSurfaceClient to
// content-hash, name, and write under `/assets/styles-<hash>.css` (the same
// immutable-caching contract as the JS bundle). We only own *producing* the
// bytes; the helper owns hashing/naming/writing and the shell rewrite.
async function buildTailwindCss(): Promise<ArrayBuffer> {
  // Invoke @tailwindcss/cli via its in-tree binary path instead of `bunx`.
  // `bunx` resolves by name and falls back to a network fetch when the local
  // copy doesn't match — the Nix build sandbox has no network, so that
  // fallback fails. `createRequire` walks Node's standard resolution from this
  // file outward, so the path stays correct regardless of where in the
  // workspace tree this file ends up.
  const tailwindBin = createRequire(import.meta.url)
    .resolve("@tailwindcss/cli/package.json")
    .replace(/package\.json$/, "dist/index.mjs");
  if (!(await Bun.file(tailwindBin).exists()))
    throw new Error(
      `Tailwind CLI not found at ${tailwindBin} — ensure @tailwindcss/cli is installed at workspace root.`,
    );
  // Tailwind has no content-hash naming of its own, so build to a temp path,
  // read the bytes, drop the temp, and hand the bytes back. The temp lives
  // in the OS temp dir (the source tree and the Nix dist may be read-only).
  const cssTmp = join(mkdtempSync(join(tmpdir(), "drishti-css-")), "styles.css");
  const cssProc = Bun.spawn(
    ["bun", tailwindBin, "-i", resolve(CLIENT_DIR, "styles.css"), "-o", cssTmp],
    { stderr: "inherit", stdout: "inherit" },
  );
  const cssCode = await cssProc.exited;
  if (cssCode !== 0) throw new Error(`@tailwindcss/cli exited ${cssCode}`);
  const cssBytes = await Bun.file(cssTmp).arrayBuffer();
  await Bun.$`rm -f ${cssTmp}`;
  return cssBytes;
}

export async function buildClient(distDir: string): Promise<void> {
  await buildSurfaceClient({
    entrypoint: resolve(CLIENT_DIR, "main.tsx"),
    distDir,
    htmlTemplate: resolve(CLIENT_DIR, "index.html"),
    entryHtmlPlaceholder: `src="./main.tsx"`,
    plugins: [solidJsxPlugin],
    extraAssets: [
      {
        name: "styles",
        ext: "css",
        build: buildTailwindCss,
        htmlPlaceholder: `href="./styles.css"`,
      },
    ],
    // Static PWA assets — the icons — shipped verbatim from client/public/.
    // They sit at the dist root (outside `/assets/`), referenced by stable
    // paths and NOT pinned immutable. NB: the `public/manifest.webmanifest`
    // that rides along is inert at runtime (the dynamic `installPwaManifest`
    // route shadows it); it stays only as the brand-color fixture
    // `brand.test.ts` asserts against.
    publicDir: resolve(CLIENT_DIR, "public"),
  });
}

// CLI entrypoint: `bun src/server/build.ts <distDir>` — used by the Nix
// build derivation's `buildPhase`. Skip when imported as a module (the
// dev server calls `buildClient` directly).
if (import.meta.main) {
  const distDir = process.argv[2];
  if (!distDir) {
    log("usage: bun src/server/build.ts <distDir>");
    process.exit(1);
  }
  await buildClient(resolve(distDir));
}
