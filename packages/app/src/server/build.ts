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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
// @ts-expect-error - babel preset types are loose
import babelTypeScript from "@babel/preset-typescript";
// @ts-expect-error - babel preset types are loose
import babelSolid from "babel-preset-solid";
import type { BunPlugin } from "bun";

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

export async function buildClient(distDir: string): Promise<void> {
  await Bun.$`mkdir -p ${distDir}`;

  // JS bundle.
  const jsResult = await Bun.build({
    entrypoints: [resolve(CLIENT_DIR, "main.tsx")],
    outdir: distDir,
    target: "browser",
    format: "esm",
    splitting: false,
    minify: false,
    sourcemap: "linked",
    plugins: [solidJsxPlugin],
  });
  if (!jsResult.success) {
    for (const m of jsResult.logs) console.error(m);
    throw new Error("Bun.build failed for client");
  }

  // Tailwind v4 CSS — invoke @tailwindcss/cli via its in-tree binary
  // path instead of `bunx`. `bunx` resolves by name and falls back to
  // a network fetch when the local copy doesn't match — the Nix build
  // sandbox has no network, so that fallback fails. Walking up from
  // this file is the boring, sandbox-safe resolution.
  const TAILWIND_BIN = resolve(
    CLIENT_DIR,
    "..",
    "..",
    "..",
    "..",
    "node_modules",
    "@tailwindcss",
    "cli",
    "dist",
    "index.mjs",
  );
  const cssProc = Bun.spawn(
    [
      "bun",
      TAILWIND_BIN,
      "-i",
      resolve(CLIENT_DIR, "styles.css"),
      "-o",
      resolve(distDir, "styles.css"),
    ],
    { stderr: "inherit", stdout: "inherit" },
  );
  const cssCode = await cssProc.exited;
  if (cssCode !== 0)
    throw new Error(`@tailwindcss/cli exited ${cssCode}`);

  // index.html is shipped verbatim. The HTML entrypoint references
  // ./main.js (Bun.build renames .tsx → .js) and ./styles.css.
  const html = await Bun.file(resolve(CLIENT_DIR, "index.html")).text();
  await Bun.write(
    resolve(distDir, "index.html"),
    html.replace(`src="./main.tsx"`, `src="./main.js"`),
  );
}

// CLI entrypoint: `bun src/server/build.ts <distDir>` — used by the Nix
// build derivation's `buildPhase`. Skip when imported as a module (the
// dev server calls `buildClient` directly).
if (import.meta.main) {
  const distDir = process.argv[2];
  if (!distDir) {
    console.error("usage: bun src/server/build.ts <distDir>");
    process.exit(1);
  }
  await buildClient(resolve(distDir));
}
