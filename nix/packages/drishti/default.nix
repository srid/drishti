# drishti build derivation — produces a staged tree under
# $out/lib/drishti ready to be exec'd by the wrappers in `../../../default.nix`.
#
# Dep fetching: `bun2nix.fetchBunDeps` reads the committed `bun.nix` and
# builds a fake Bun cache via per-tarball FODs (hashes from the lockfile,
# no network in the build sandbox). `bun2nix.hook` installs that cache
# into $src via `bun install --ignore-scripts`.
#
# Client bundling: re-uses `packages/app/src/server/build.ts` — the same
# TS code path the dev server invokes when DRISHTI_DIST_DIR is unset.
# One bundle pipeline; two callers.
{ stdenv, lib, bun, bun2nix, kolu-surface, kolu-surface-nix-host, kolu-surface-app, kolu-solid-pwa-install, surfaceAppCommit ? "dev" }:
# `@tailwindcss/cli` transitively dlopen()s `@parcel/watcher`'s native
# binding, which requires `libstdc++.so.6` at runtime even when we don't
# use --watch. Expose stdenv's libstdc++ via LD_LIBRARY_PATH during the
# buildPhase so the dlopen succeeds; without this the buildPhase fails
# with `ERR_DLOPEN_FAILED` at module load.
let
  # Compose surface-app's build-commit helper from the EXTRACTED package tree
  # (kolu-surface-app is the runCommand-staged `packages/surface-app`), so the
  # env-var name + export-line shape are single-sourced upstream, not hardcoded.
  stamp = import (kolu-surface-app + "/nix/commit-stamp.nix") { };
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../package.json
      ../../../bun.lock
      ../../../bunfig.toml
      ../../../tsconfig.base.json
      ../../../bun.nix
      ../../../packages/app
      # packages/app now imports the wire contract from `drishti-common`, and
      # `bun install` resolves the whole workspace — so every member must be
      # present for the install to succeed. Including packages/agent here too
      # keeps the monitor's workspace complete (the monitor rebuilds on any
      # edit regardless, so the agent source riding along costs nothing); the
      # AGENT's drv stays scoped via its own derivation, which excludes app.
      ../../../packages/common
      ../../../packages/agent
      # @kolu/* hydration script — invoked from postBunNodeModulesInstallPhase
      # below. Source path must be inside the fileset for the build to see it.
      ../../../scripts
    ];
  };
in
stdenv.mkDerivation {
  pname = "drishti-built";
  version = "0.1.0";
  inherit src;

  # `bun2nix.hook` propagates its own bun (currently 1.3.8) via
  # propagated-build-inputs; on aarch64-darwin that version has a
  # hoisted-linker bug that surfaces as "AccessDenied: Failed to open
  # node_modules folder" on `babel-plugin-jsx-dom-expressions`.
  # Listing our npins-pinned `bun` first wins on PATH and produces a
  # reproducible install across both linux-x64 and darwin-arm64.
  nativeBuildInputs = [ bun bun2nix.hook ];

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../../../bun.nix;
  };

  # hoisted linker matches `bunfig.toml`: @kolu/surface-nix-host (hydrated
  # below) needs to resolve its transitive deps (@kolu/surface, @orpc/*,
  # zod) from the workspace-root node_modules, not from an isolated
  # per-package tree.
  bunInstallFlags = [ "--linker=hoisted" ];

  # The fixupPhase walks node_modules and patches shebangs / ELF. For a
  # Bun app this is pure overhead — Bun runs the source directly, no
  # shebangs we care about, no native binaries.
  dontFixup = true;
  dontPatchShebangs = true;

  # @kolu/surface, @kolu/surface-nix-host and @kolu/surface-app are NOT in
  # bun.lock — they're Nix-store sources supplied by the overlay (same hydration strategy as
  # `shell.nix`'s shellHook and the `just install` recipe). Drop the
  # copies in *after* bun install populates node_modules, otherwise bun
  # install would either overwrite our copies or refuse to proceed.
  postBunNodeModulesInstallPhase = ''
    sh scripts/hydrate-kolu-packages.sh \
      ${kolu-surface} @kolu/surface \
      ${kolu-surface-nix-host} @kolu/surface-nix-host \
      ${kolu-surface-app} @kolu/surface-app \
      ${kolu-solid-pwa-install} @kolu/solid-pwa-install
  '';

  # Skip the hook's default `bun build --compile` invocation — that flag
  # set targets single-binary executables, which doesn't fit drishti
  # (server entry + dist tree + node_modules + agent entry).
  dontUseBunBuild = true;

  buildPhase = ''
    runHook preBuild
    export LD_LIBRARY_PATH="${stdenv.cc.cc.lib}/lib:''${LD_LIBRARY_PATH:-}"
    # Stamp the build commit into the client bundle. The sandbox has no git,
    # so resolveCommit() would otherwise fall back to "dev"; the server wrapper
    # is stamped with the SAME value, so the freshness rail shows one consistent
    # `srv · client` commit instead of `<sha> · dev`.
    ${stamp.exportLine surfaceAppCommit}
    mkdir -p packages/app/dist
    bun packages/app/src/server/build.ts packages/app/dist
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/drishti
    cp -r packages $out/lib/drishti/
    cp -r node_modules $out/lib/drishti/
    cp package.json bunfig.toml tsconfig.base.json $out/lib/drishti/
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
    description = "drishti — built source tree (server + agent + bundled client + node_modules)";
    platforms = lib.platforms.unix;
  };
}
