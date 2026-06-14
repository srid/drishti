# drishti-agent build derivation — the remote-side binary's staged tree.
#
# This is the keystone of issue #38. The monitor (`../drishti`) and the agent
# used to share ONE build derivation (`drishtiBuilt`), so every client/server
# edit rotated the agent's `.drv` hash and every remote paid a full cross-arch
# `nix copy` + realise on the next reconnect. This derivation scopes the agent
# to ONLY its own SOURCE, so a client/server-only rebuild leaves the agent
# `.drv` byte-identical and every remote's cached agent stays warm.
#
# Two churn edges are cut, both necessary:
#
#   1. `src` — a narrow fileset of packages/agent + packages/common (the wire
#      contract) + the workspace metadata. packages/app's SOURCE is deliberately
#      absent; only its `package.json` rides along, because the pnpm
#      `--frozen-lockfile` install validates every workspace importer's manifest
#      against the lockfile and would fail if `packages/app` vanished entirely.
#      Editing app SOURCE (client/server) leaves this fileset byte-identical;
#      only an app DEPENDENCY change (its package.json) — which also moves the
#      lockfile — legitimately rotates the agent.
#
#   2. `pnpmDeps` — the shared offline store fetched in ../../../default.nix from
#      the MANIFESTS + lockfile only (no package source). Its FOD `.drv` is
#      invariant to source edits, so sharing it with the monitor doesn't
#      reintroduce churn. (Under bun2nix this required filtering the `drishti-app`
#      workspace FOD out of bun.nix; pnpm's manifests-only fetch needs no such
#      surgery.)
#
# Acceptance test (`just drv-stability`, also a CI node): a committed client
# edit must leave `drishti-agent.drvPath` unchanged.
#
# `@kolu/surface` is hydrated post-install exactly as in the monitor build
# (it is a Nix-store source, not a lockfile entry). The agent needs only
# @kolu/surface (not surface-nix-host, the parent's provisioning lib, nor
# surface-app, the client). Its support deps (@orpc/contract, zod on
# drishti-common; @orpc/server, @orpc/client on drishti-agent) are declared by
# those manifests so the hoisted node_modules resolves them.
{ stdenv
, lib
, nodejs
, pnpm
, pnpmConfigHook
, pnpmDeps
, kolu-surface
}:
let
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../package.json
      ../../../pnpm-lock.yaml
      ../../../pnpm-workspace.yaml
      ../../../.npmrc
      ../../../tsconfig.base.json
      # packages/app's MANIFEST only (not its source) — keeps the frozen pnpm
      # workspace install valid without dragging client/server source into the
      # agent's drv. See churn-edge note #1 in the header.
      ../../../packages/app/package.json
      ../../../packages/agent
      ../../../packages/common
      # @kolu/* hydration script — invoked from preInstall below.
      ../../../scripts
    ];
  };
in
stdenv.mkDerivation {
  pname = "drishti-agent-built";
  version = "0.1.0";
  inherit src pnpmDeps;

  nativeBuildInputs = [ nodejs pnpm pnpmConfigHook ];

  # tsx runs the source directly — no fixup, and no client bundle to build.
  dontFixup = true;
  dontBuild = true;

  # @kolu/surface is a Nix-store source, not a lockfile entry — drop it into
  # node_modules AFTER pnpmConfigHook's install (so the frozen install doesn't
  # prune it) and BEFORE the installPhase copies node_modules into $out.
  preInstall = ''
    sh scripts/hydrate-kolu-packages.sh \
      ${kolu-surface} @kolu/surface
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/drishti
    cp -r packages $out/lib/drishti/
    cp -r node_modules $out/lib/drishti/
    cp package.json pnpm-workspace.yaml .npmrc tsconfig.base.json $out/lib/drishti/
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
