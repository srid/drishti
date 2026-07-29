# drishti-agent build derivation — the remote-side binary's staged tree.
#
# This is the keystone of issue #38 / U5.1. The agent consumes a POSITIVE
# dependency projection — never the shared root bun.nix with a denylist:
#
#   1. `src` — packages/agent + packages/common + workspace package.json.
#      Root bun.lock / bunfig.toml / bun.nix are NOT in the fileset.
#
#   2. `bunDeps` — fetchBunDeps over packages/agent/agent.bun.nix only
#      (generated from the agent-scoped lock). App-only npm FODs never enter
#      the attrset, so an unlisted app-only key mutation of root bun.nix
#      cannot rotate fleet BUILD_ID.
#
#   3. Install metadata — packages/agent/agent.lock + agent.bunfig.toml.
#      Regenerated only when agent/common deps change
#      (`just regenerate-agent-deps`).
#
# Acceptance (`just ci::drv-stability`):
#   (a) real app-only devDependency + lock/bun.nix regen → BUILD_ID unchanged
#   (b) agent-touching source edit → BUILD_ID rotates
#
# UW3: accidental agent-drv change is a fleet-wide daemon restart.
{ stdenv, lib, bun, bun2nix, kolu-surface, kolu-surface-daemon, osfacts-client }:
let
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../package.json
      ../../../tsconfig.base.json
      ../../../packages/agent
      ../../../packages/common
      ../../../scripts
    ];
  };
in
stdenv.mkDerivation {
  pname = "drishti-agent-built";
  version = "0.1.0";
  inherit src;

  nativeBuildInputs = [ bun bun2nix.hook ];

  # POSITIVE projection: only packages/agent/agent.bun.nix — never import
  # the root bun.nix (no denylist of app-test packages).
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../../../packages/agent/agent.bun.nix;
  };

  bunInstallFlags = [ "--linker=hoisted" ];

  dontFixup = true;
  dontPatchShebangs = true;
  dontUseBunBuild = true;
  dontBuild = true;

  # Agent-scoped lock + bunfig; replace package.json so it matches the
  # agent lock workspaces (no packages/app, no root typescript/@types/bun).
  postPatch = ''
    cp packages/agent/agent.lock bun.lock
    cp packages/agent/agent.bunfig.toml bunfig.toml
    cat > package.json <<'EOF'
    {
      "name": "drishti-agent-workspace",
      "private": true,
      "type": "module",
      "workspaces": ["packages/agent", "packages/common"],
      "overrides": {
        "@babel/helper-module-imports": "^7.29.7"
      }
    }
    EOF
  '';

  postBunNodeModulesInstallPhase = ''
    sh scripts/hydrate-kolu-packages.sh \
      ${kolu-surface} @kolu/surface \
      ${kolu-surface-daemon} @kolu/surface-daemon \
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
