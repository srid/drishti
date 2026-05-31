# drishti-agent build derivation — the remote-side binary's staged tree.
#
# This is the keystone of issue #38. The monitor (`../drishti`) and the agent
# used to share ONE build derivation (`drishtiBuilt`), so every client/server
# edit rotated the agent's `.drv` hash and every remote paid a full cross-arch
# `nix copy` + realise on the next reconnect. This derivation scopes the agent
# to ONLY its own inputs, so a client/server-only rebuild leaves the agent
# `.drv` byte-identical and every remote's cached agent stays warm.
#
# Two churn edges are cut here, both necessary:
#
#   1. `src` — a narrow fileset of packages/agent + packages/common (the wire
#      contract) + the workspace metadata. packages/app (client + server) is
#      deliberately absent, so editing it cannot rehash `src`.
#
#   2. `bunDeps` — `fetchBunDeps` builds a `symlinkJoin` over every entry in
#      `bun.nix`, INCLUDING `"drishti-app" = copyPathToStore ./packages/app`
#      (bun2nix bakes each workspace member's source into the dep cache). That
#      FOD takes packages/app's source as a direct Nix input, so a naive reuse
#      of the full `bun.nix` would still churn the agent on client edits even
#      with a narrow `src`. We pass a `bun.nix` with the `drishti-app` entry
#      removed; the agent depends only on drishti-common + npm tarballs, none
#      of which move when client/server source changes.
#
# Acceptance test (`just drv-stability`, also a CI node): a committed client
# edit must leave `drishti-agent.drvPath` unchanged.
#
# `@kolu/surface` is hydrated post-install exactly as in the monitor build
# (it is a Nix-store source, not a bun.lock entry). Because it's hydrated, its
# support deps must be declared by consumers so the hoisted node_modules
# resolves them — and this build excludes packages/app, so it can't lean on the
# monitor's declarations. The split mirrors the import graph: the wire
# contract's needs (@orpc/contract, zod) live on drishti-common; the
# server/peer-server deps the agent serves (@orpc/server, @orpc/client — the
# latter pulled by peer-server's stdio-codec) live on drishti-agent. No agent-
# reachable @kolu/surface entrypoint imports solid-js, so it is not declared.
{ stdenv, lib, bun, bun2nix, kolu-surface }:
let
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../package.json
      ../../../bun.lock
      ../../../bunfig.toml
      ../../../tsconfig.base.json
      ../../../bun.nix
      ../../../packages/agent
      ../../../packages/common
      # @kolu/* hydration script — invoked from postBunNodeModulesInstallPhase.
      ../../../scripts
    ];
  };
in
stdenv.mkDerivation {
  pname = "drishti-agent-built";
  version = "0.1.0";
  inherit src;

  # Listing our npins-pinned `bun` first wins on PATH over bun2nix.hook's
  # propagated bun (same reproducibility reason as the monitor build).
  nativeBuildInputs = [ bun bun2nix.hook ];

  # The agent's dep cache, with the `drishti-app` workspace FOD filtered out
  # (see the churn-edge note in the header). `fetchBunDeps` calls
  # `pkgs.callPackage bunNix { ... }`, so a function with bun.nix's signature
  # that forwards its args and drops one attr is a drop-in replacement.
  bunDeps = bun2nix.fetchBunDeps {
    bunNix =
      { copyPathToStore, fetchFromGitHub, fetchgit, fetchurl, ... }@bunNixArgs:
      builtins.removeAttrs (import ../../../bun.nix bunNixArgs) [ "drishti-app" ];
  };

  # hoisted linker matches `bunfig.toml`: hydrated @kolu/surface must resolve
  # its transitive deps (@orpc/*, zod, solid-js) from the workspace-root
  # node_modules, not from an isolated per-package tree.
  bunInstallFlags = [ "--linker=hoisted" ];

  # Pure overhead for a Bun app — no shebangs we care about, no native binaries.
  dontFixup = true;
  dontPatchShebangs = true;

  # No client bundle: the agent never reads dist, and dropping the build step
  # keeps the churniest output out of the agent's closure entirely.
  dontUseBunBuild = true;
  dontBuild = true;

  # @kolu/surface is a Nix-store source, not a bun.lock entry — drop it in
  # after bun install populates node_modules. The agent needs only
  # @kolu/surface (not surface-nix-host, which is the parent's provisioning lib).
  postBunNodeModulesInstallPhase = ''
    sh scripts/hydrate-kolu-packages.sh \
      ${kolu-surface} @kolu/surface
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/drishti
    cp -r packages $out/lib/drishti/
    cp -r node_modules $out/lib/drishti/
    cp package.json bunfig.toml tsconfig.base.json $out/lib/drishti/
    # Guard: the wrapper in ../../../default.nix hard-codes this entry-point
    # path. Fail the build (not runtime) if it moves.
    entry="$out/lib/drishti/packages/agent/src/main.ts"
    test -e "$entry" || {
      echo "installPhase: $entry missing — update default.nix if the path changed"
      exit 1
    }
    runHook postInstall
  '';

  meta = {
    description = "drishti agent — minimal built tree (agent + wire contract + node_modules), no client bundle";
    platforms = lib.platforms.unix;
  };
}
