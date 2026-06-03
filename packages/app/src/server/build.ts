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

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
// @ts-expect-error - babel preset types are loose
import babelTypeScript from "@babel/preset-typescript";
// @ts-expect-error - babel preset types are loose
import babelSolid from "babel-preset-solid";
import type { BunPlugin } from "bun";
// surface-app owns the build commit (one source of truth, env → git → "dev").
// resolveCommit is node-only (no Vite dependency), so it works from this
// Bun build path; the same value is read server-side by `buildInfoServer()`.
import { resolveCommit } from "@kolu/surface-app/vite";
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

// The content-hashed asset directory, relative to the dist root. surface-app's
// `installFreshStatic` pins exactly `/assets/*` `immutable` (a year, never
// revalidated) and 404s a miss there rather than serving the HTML shell under a
// `.js` URL — so only files under this prefix may carry a content hash, and the
// no-store shell (index.html) must stay at the root referencing them by their
// hashed URL.
const ASSET_DIR = "assets";

export async function buildClient(distDir: string): Promise<void> {
  await Bun.$`mkdir -p ${distDir}`;
  const assetsDir = resolve(distDir, ASSET_DIR);
  await Bun.$`mkdir -p ${assetsDir}`;

  // JS bundle. Minified — Bun emits a linked sourcemap so DevTools still
  // surfaces original sources, but the wire/parse cost on first paint
  // drops by ~3× vs. the unminified output.
  //
  // `naming` carries a `[hash]` token so the entry lands at
  // `/assets/main-<hash>.js`: a content hash is the prerequisite for
  // surface-app's `immutable` caching — the byte-identical bundle keeps its
  // URL across rebuilds, a changed bundle gets a new one, so an installed
  // client can pin assets for a year yet always converge after a deploy. The
  // bundle define stamps the build commit into the client (`__SURFACE_APP_COMMIT__`),
  // the same value `buildInfoServer()` reads on the server — that's what makes
  // skew visible.
  const jsResult = await Bun.build({
    entrypoints: [resolve(CLIENT_DIR, "main.tsx")],
    outdir: assetsDir,
    naming: "[name]-[hash].[ext]",
    target: "browser",
    format: "esm",
    splitting: false,
    minify: true,
    sourcemap: "linked",
    define: { __SURFACE_APP_COMMIT__: JSON.stringify(resolveCommit()) },
    plugins: [solidJsxPlugin],
  });
  if (!jsResult.success) {
    for (const m of jsResult.logs) log(m.message);
    throw new Error("Bun.build failed for client");
  }
  // The hashed entry URL the HTML shell must point at. The entrypoint output
  // is the one `.js` whose name isn't a chunk; with splitting off there's a
  // single js artifact, but find it by `kind` to stay correct if that changes.
  const jsEntry = jsResult.outputs.find(
    (o) => o.kind === "entry-point" && o.path.endsWith(".js"),
  );
  if (!jsEntry) throw new Error("Bun.build produced no JS entry output");
  const jsHref = `/${ASSET_DIR}/${basename(jsEntry.path)}`;

  // Tailwind v4 CSS — invoke @tailwindcss/cli via its in-tree binary
  // path instead of `bunx`. `bunx` resolves by name and falls back to
  // a network fetch when the local copy doesn't match — the Nix build
  // sandbox has no network, so that fallback fails. `createRequire`
  // walks Node's standard resolution from this file outward, so the
  // path stays correct regardless of where in the workspace tree the
  // build.ts file ends up.
  const TAILWIND_BIN = createRequire(import.meta.url).resolve(
    "@tailwindcss/cli/package.json",
  ).replace(/package\.json$/, "dist/index.mjs");
  if (!(await Bun.file(TAILWIND_BIN).exists()))
    throw new Error(
      `Tailwind CLI not found at ${TAILWIND_BIN} — ensure @tailwindcss/cli is installed at workspace root.`,
    );
  // Tailwind has no content-hash naming of its own, so build the CSS to a
  // temp path, then write it under `/assets/styles-<hash>.css` keyed on its
  // own bytes — the same immutable-caching contract as the JS bundle. Bun's
  // `hash` gives a stable short digest; identical CSS keeps its URL, changed
  // CSS gets a new one.
  const cssTmp = resolve(assetsDir, "styles.tmp.css");
  const cssProc = Bun.spawn(
    ["bun", TAILWIND_BIN, "-i", resolve(CLIENT_DIR, "styles.css"), "-o", cssTmp],
    { stderr: "inherit", stdout: "inherit" },
  );
  const cssCode = await cssProc.exited;
  if (cssCode !== 0) throw new Error(`@tailwindcss/cli exited ${cssCode}`);
  const cssBytes = await Bun.file(cssTmp).arrayBuffer();
  const cssHash = Bun.hash(cssBytes).toString(16).slice(0, 8);
  const cssName = `styles-${cssHash}.css`;
  await Bun.write(resolve(assetsDir, cssName), cssBytes);
  await Bun.$`rm -f ${cssTmp}`;
  const cssHref = `/${ASSET_DIR}/${cssName}`;

  // index.html is the no-store SPA shell — it stays UNHASHED at the root
  // (surface-app serves it `no-store`) and is rewritten to reference the
  // hashed `/assets/*` URLs of the bundle and stylesheet. The shell is always
  // re-fetched; the assets it names are pinned immutable — that's the whole
  // freshness contract.
  const html = await Bun.file(resolve(CLIENT_DIR, "index.html")).text();
  await Bun.write(
    resolve(distDir, "index.html"),
    html
      .replace(`src="./main.tsx"`, `src="${jsHref}"`)
      .replace(`href="./styles.css"`, `href="${cssHref}"`),
  );

  // Static PWA assets — the icons (and a fallback manifest) — are shipped
  // verbatim. They live under client/public/ so "which static assets exist"
  // is encapsulated in one directory; this step copies the tree wholesale
  // instead of enumerating filenames that would drift. NB: drishti no longer
  // ships its own caching service worker — surface-app serves a
  // self-destructing `/sw.js` from the server (it unregisters any legacy
  // worker a prior build left behind), and the manifest is served dynamically
  // by `installPwaManifest`. The icons are referenced by stable paths, so they
  // sit at the dist root (outside `/assets/`) and are NOT pinned immutable.
  const PUBLIC_DIR = resolve(CLIENT_DIR, "public");
  if (!existsSync(PUBLIC_DIR))
    throw new Error(
      `public assets dir missing at ${PUBLIC_DIR} — run \`just gen-pwa-icons\` to generate the icons.`,
    );
  await Bun.$`cp -R ${PUBLIC_DIR}/. ${distDir}/`;
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
