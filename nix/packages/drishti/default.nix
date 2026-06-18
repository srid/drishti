# drishti build derivation — produces a staged tree under
# $out/lib/drishti ready to be exec'd (via tsx) by the wrappers in
# `../../../default.nix`.
#
# Dep install: `pnpmConfigHook` unpacks the shared offline pnpm store
# (`pnpmDeps`, fetched once in ../../../default.nix from the manifests +
# lockfile) and runs `pnpm install --offline --frozen-lockfile` over the
# workspace. `.npmrc` pins `node-linker=hoisted` so the hydrated @kolu/*
# sources resolve their transitive deps from one root node_modules.
#
# Client bundling: re-uses `packages/app/src/server/build.ts` — the same
# Vite build the dev server invokes when DRISHTI_DIST_DIR is unset. One
# bundle pipeline; two callers.
{ stdenv
, lib
, nodejs
, pnpm
, pnpmConfigHook
, tsx
, pnpmDeps
, kolu-surface
, kolu-surface-nix-host
, kolu-surface-app
, kolu-solid-pwa-install
, surfaceAppCommit ? "dev"
}:
let
  # Compose surface-app's build-commit helper from the EXTRACTED package tree
  # (kolu-surface-app is the runCommand-staged `packages/surface-app`), so the
  # env-var name + export-line shape are single-sourced upstream, not hardcoded.
  stamp = import (kolu-surface-app + "/nix/commit-stamp.nix") { };
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../package.json
      ../../../pnpm-lock.yaml
      ../../../pnpm-workspace.yaml
      ../../../.npmrc
      ../../../tsconfig.base.json
      ../../../packages/app
      # packages/app imports the wire contract from `drishti-common`, and the
      # pnpm install resolves the whole workspace — so every member must be
      # present. Including packages/agent here too keeps the monitor's workspace
      # complete (the monitor rebuilds on any edit regardless, so the agent
      # source riding along costs nothing); the AGENT's drv stays scoped via its
      # own derivation, which excludes app source.
      ../../../packages/common
      ../../../packages/agent
      # @kolu/* hydration script — invoked from buildPhase below. Source path
      # must be inside the fileset for the build to see it.
      ../../../scripts
    ];
  };
in
stdenv.mkDerivation {
  pname = "drishti-built";
  version = "0.1.0";
  inherit src pnpmDeps;

  nativeBuildInputs = [ nodejs pnpm pnpmConfigHook tsx ];

  # tsx runs the TypeScript sources directly — nothing to fix up, and the
  # node_modules tree carries native bindings we must not strip.
  dontFixup = true;

  buildPhase = ''
    runHook preBuild
    # @tailwindcss/oxide + lightningcss (the Vite Tailwind plugin's native
    # bindings) dlopen() against libstdc++.so.6 during the client build.
    export LD_LIBRARY_PATH="${stdenv.cc.cc.lib}/lib:''${LD_LIBRARY_PATH:-}"
    # @kolu/surface, @kolu/surface-nix-host, @kolu/surface-app and
    # @kolu/solid-pwa-install are NOT in the lockfile — they're Nix-store
    # sources supplied by the overlay. Drop them into node_modules AFTER
    # pnpmConfigHook's install populated it (otherwise pnpm's frozen install
    # would treat them as extraneous and prune them) and BEFORE the Vite build
    # reads them.
    #
    # NB: hydration lives in `buildPhase` here, but in `preInstall` for the
    # agent derivation — the asymmetry is forced, not an oversight. The Vite
    # build below (`tsx build.ts`) imports @kolu/surface-app/vite and the client
    # tree imports @kolu/* at bundle time, so the hydrated tree must exist before
    # this phase's build runs. The agent has no build (`dontBuild = true`), so
    # nothing consumes the hydration until `cp -r node_modules` in installPhase —
    # there `preInstall` is the natural seam. Placement tracks the consumer.
    sh scripts/hydrate-kolu-packages.sh \
      ${kolu-surface} @kolu/surface \
      ${kolu-surface-nix-host} @kolu/surface-nix-host \
      ${kolu-surface-app} @kolu/surface-app \
      ${kolu-solid-pwa-install} @kolu/solid-pwa-install
    # Stamp the build commit into the client bundle. The sandbox has no git,
    # so resolveCommit() would otherwise fall back to "dev"; the server wrapper
    # is stamped with the SAME value, so the freshness rail shows one consistent
    # `srv · client` commit instead of `<sha> · dev`.
    ${stamp.exportLine surfaceAppCommit}
    mkdir -p packages/app/dist
    tsx packages/app/src/server/build.ts packages/app/dist
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/drishti
    cp -r packages $out/lib/drishti/
    cp -r node_modules $out/lib/drishti/
    cp package.json pnpm-workspace.yaml .npmrc tsconfig.base.json $out/lib/drishti/
    # Guards: the wrappers in default.nix hard-code these entry-point
    # paths. Fail the build (not runtime) if either moves.
    for entry in \
      "$out/lib/drishti/packages/app/src/server/main.ts" \
      "$out/lib/drishti/packages/app/dist/index.html"
    do
      test -e "$entry" || {
        echo "installPhase: $entry missing — update default.nix if the path changed"
        exit 1
      }
    done
    runHook postInstall
  '';

  meta = {
    description = "drishti — built source tree (server + agent + Vite-bundled client + node_modules)";
    platforms = lib.platforms.unix;
  };
}
