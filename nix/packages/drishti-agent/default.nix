# drishti-agent build derivation — the remote-side binary's staged tree.
#
# This is the keystone of issue #38 / U5.1 / U6.1. The agent consumes a
# POSITIVE dependency projection and a MINIMAL source fileset:
#
#   1. `src` — packages/agent + packages/common + agent.package.json +
#      agent.lock + agent.bunfig.toml + hydrate-kolu-packages.sh only.
#      Root package.json and the rest of scripts/ are NOT inputs (U6.1).
#
#   2. `bunDeps` — fetchBunDeps over packages/agent/agent.bun.nix only.
#
#   3. Install metadata — agent.lock + agent.bunfig.toml + agent.package.json
#      regenerated only when agent/common deps change
#      (`just regenerate-agent-deps`).
#
# Acceptance (`just ci::drv-stability`):
#   app-only / root-manifest / app-script edits → BUILD_ID unchanged
#   agent-touching source edit → BUILD_ID rotates
#
# UW3: accidental agent-drv change is a fleet-wide daemon restart.
#
# juspay/kolu#2101: `@kolu/surface-daemon-supervisor` joined the hydrated set
# when the `--stdio` front started CONVERGING the durable daemon before it
# relays a byte. The kit runs in the fronting process, never in the daemon, so
# it cannot change what a daemon restart loads — but the front is the agent
# binary, so the closure has to carry it. `ts-pattern` joins agent.package.json
# for the same reason: it is a real runtime import of that kit (unlike
# `@kolu/log`, which surface-daemon takes as `import type` only).
{ stdenv, lib, bun, bun2nix, kolu-surface, kolu-surface-daemon, kolu-surface-daemon-supervisor, osfacts-client }:
let
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../packages/agent
      ../../../packages/common
      # Single hydrate script — not the whole scripts/ directory (U6.1).
      ../../../scripts/hydrate-kolu-packages.sh
      # tsconfig.base is extended by packages/*/tsconfig.json.
      ../../../tsconfig.base.json
    ];
  };
in
stdenv.mkDerivation {
  pname = "drishti-agent-built";
  version = "0.1.0";
  inherit src;

  nativeBuildInputs = [ bun bun2nix.hook ];

  # POSITIVE projection: only packages/agent/agent.bun.nix.
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../../../packages/agent/agent.bun.nix;
  };

  bunInstallFlags = [ "--linker=hoisted" ];

  dontFixup = true;
  dontPatchShebangs = true;
  dontUseBunBuild = true;
  dontBuild = true;

  # Exact agent-workspace manifest (not a postPatch rewrite of root package.json).
  postPatch = ''
    cp packages/agent/agent.package.json package.json
    cp packages/agent/agent.lock bun.lock
    cp packages/agent/agent.bunfig.toml bunfig.toml
    # hydrate script lives under scripts/ in the install layout
    mkdir -p scripts
    # fileset places hydrate-kolu-packages.sh at scripts/ relative to root
    test -f scripts/hydrate-kolu-packages.sh
  '';

  postBunNodeModulesInstallPhase = ''
    sh scripts/hydrate-kolu-packages.sh \
      ${kolu-surface} @kolu/surface \
      ${kolu-surface-daemon} @kolu/surface-daemon \
      ${kolu-surface-daemon-supervisor} @kolu/surface-daemon-supervisor \
      ${osfacts-client} osfacts-client
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/drishti
    cp -r packages $out/lib/drishti/
    cp -r node_modules $out/lib/drishti/
    cp package.json bunfig.toml tsconfig.base.json $out/lib/drishti/
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
