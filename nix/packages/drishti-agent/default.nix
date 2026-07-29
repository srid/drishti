# drishti-agent build derivation — the remote-side binary's staged tree.
#
# This is the keystone of issue #38. The monitor (`../drishti`) and the agent
# used to share ONE build derivation (`drishtiBuilt`), so every client/server
# edit rotated the agent's `.drv` hash and every remote paid a full cross-arch
# `nix copy` + realise on the next reconnect. This derivation scopes the agent
# to ONLY its own inputs, so a client/server-only rebuild leaves the agent
# `.drv` byte-identical and every remote's cached agent stays warm.
#
# Three churn edges are cut here, all necessary:
#
#   1. `src` — packages/agent + packages/common + workspace package.json +
#      agent-scoped install metadata. packages/app is absent. The ROOT
#      bun.lock / bunfig.toml / bun.nix are ALSO absent: those files absorb
#      app-only test tooling (happy-dom, @solidjs/testing-library, …) and
#      used to rotate fleet BUILD_ID on UI-test waves (U4.1).
#
#   2. `bunDeps` — `fetchBunDeps` over an agent-filtered bun.nix that drops
#      the drishti-app workspace FOD AND every known app-test-only package.
#      Adding an app-only npm fetch must not rehash the agent cache join.
#
#   3. Install metadata — `packages/agent/agent.lock` + `agent.bunfig.toml`
#      (linker only). Regenerated only when agent/common deps change, never
#      when app test deps land in the workspace root lock.
#
# Acceptance (`just ci::drv-stability`): client .ts edit AND app-only
# lock/devDependency mutation leave BUILD_ID unchanged; agent-touching
# mutation rotates it.
#
# UW3: accidental agent-drv change is a fleet-wide daemon restart, not a
# quiet rebuild.
#
# `@kolu/surface` is hydrated post-install. The agent declares the runtime
# deps of hydrated sources itself (packages/agent/package.json).
{ stdenv, lib, bun, bun2nix, kolu-surface, kolu-surface-daemon, osfacts-client }:
let
  # Package name prefixes (bun.nix keys are "name@version") that exist only
  # for app/browser tests. Extending this list is required when a new
  # app-only test dep would otherwise re-enter the agent cache.
  appTestOnlyNamePrefixes = [
    "happy-dom@"
    "@happy-dom/"
    "@solidjs/testing-library@"
    "@testing-library/"
    "aria-query@"
    "@types/aria-query@"
    "dom-accessibility-api@"
    "pretty-format@"
    "lz-string@"
    "react-is@"
    "ansi-regex@"
    "ansi-styles@"
    "@babel/runtime@"
    "buffer-image-size@"
    "entities@7." # happy-dom's entities; parse5's entities@6 stays for monitor
    "@types/whatwg-mimetype@"
    "whatwg-mimetype@"
  ];

  isAppTestOnlyKey = name:
    lib.any (p: lib.hasPrefix p name) appTestOnlyNamePrefixes;

  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../package.json
      ../../../tsconfig.base.json
      ../../../packages/agent
      ../../../packages/common
      # @kolu/* hydration script — invoked from postBunNodeModulesInstallPhase.
      ../../../scripts
      # Agent-scoped install metadata (NOT the workspace-root lock/bunfig).
      # Root bun.lock / bunfig.toml / bun.nix stay out of this fileset.
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

  # Agent dep cache: drop workspace app FOD + app-test-only npm FODs.
  bunDeps = bun2nix.fetchBunDeps {
    bunNix =
      { copyPathToStore, fetchFromGitHub, fetchgit, fetchurl, ... }@bunNixArgs:
      let
        full = import ../../../bun.nix bunNixArgs;
        drop = name: name == "drishti-app" || isAppTestOnlyKey name;
      in
      lib.filterAttrs (name: _: !drop name) full;
  };

  bunInstallFlags = [ "--linker=hoisted" ];

  dontFixup = true;
  dontPatchShebangs = true;
  dontUseBunBuild = true;
  dontBuild = true;

  # Point bun install at the agent-scoped lock + bunfig (stable under app
  # test churn). Root workspace files are deliberately not in `src`.
  postPatch = ''
    cp packages/agent/agent.lock bun.lock
    cp packages/agent/agent.bunfig.toml bunfig.toml
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
