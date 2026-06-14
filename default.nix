# Root composer for drishti Nix derivations.
#
# The dev shell consumes `kolu-surface` + `kolu-surface-nix-host` (via
# `nix/env.nix`); the wrappers below feed `nix run` / `nix build`.
#
# User-facing derivations. The monitor + client are backed by `drishtiBuilt`
# (the full app tree + Vite-built client bundle); the agent is backed by its
# own minimal `drishtiAgentBuilt` so client/server edits don't churn its `.drv`
# (issue #38).
#
#   drishti-agent  — the remote-side binary. `nix copy --derivation` ships
#                     this .drv to the SSH target host, which realises it
#                     locally. Wraps tsx → packages/agent/src/main.ts, built by
#                     `drishtiAgentBuilt` (NOT the full `drishtiBuilt` tree — see
#                     nix/packages/drishti-agent/default.nix for why scoping the
#                     agent's source is the fix for the reconnect re-provision).
#
#   drishti-client — the static client bundle ($out is the dist dir).
#                     The monitor wrapper bakes DRISHTI_DIST_DIR to this.
#
#   drishti        — the monitor (default attr). Wraps tsx →
#                     packages/app/src/server/main.ts; bakes
#                     DRISHTI_AGENT_DRVS_JSON (system→drv map, sourced
#                     from flake.nix) and DRISHTI_DIST_DIR (drishti-
#                     client). meta.mainProgram is "drishti" so `nix run`
#                     resolves cleanly.
#
# `pnpmDeps` (the offline pnpm store) is fetched ONCE here from the
# manifests + lockfile and shared by both build derivations. Its fetch `src`
# is manifests-only (no package source), so a client/server source edit never
# rotates the shared dep FOD's `.drv` — a prerequisite for the agent's
# drv-stability (issue #38) alongside the agent build's narrow source fileset.
#
# `agentDrvBySystem` is the cross-system map flake.nix builds eagerly
# (drvPath is pure eval; no IFD) and threads in here so the monitor can
# pick the right agent at runtime per the remote host's `uname -ms`.
# Only the `drishti` monitor needs it — `drishti-agent` and
# `drishti-client` realize fine without it; throws on use if missing.
{ pkgs ? null
, agentDrvBySystem ? null
  # Build commit, stamped into the client bundle AND the server wrapper from
  # one source (flake.nix passes `self.rev`), so the freshness rail is
  # self-consistent. Defaults to "dev" for non-flake (`nix-build`) invocations.
, rev ? "dev"
}:
let
  # surface-app's build-commit helper (upstream single source for the env-var
  # name) — composed here so the server wrapper's --set name stays equal to the
  # client define rather than repeating the "SURFACE_APP_COMMIT" literal.
  stamp = import ((import ./npins).kolu + "/packages/surface-app/nix/commit-stamp.nix") { };
  resolvedPkgs =
    if pkgs != null
    then pkgs
    else import ./nix/nixpkgs.nix { };

  lib = resolvedPkgs.lib;

  # The offline pnpm store, fetched from the manifests + lockfile only. Because
  # the fetch `src` carries no package SOURCE, a client/server edit can't rotate
  # this FOD's `.drv` — so it is safe to share between the monitor and the agent
  # without reintroducing the agent drv churn issue #38 exists to prevent.
  #
  # This is deliberately MORE conservative than juspay/odu, whose fetchPnpmDeps
  # `src` includes `./src`: odu has a single build derivation and no
  # cross-derivation drv-stability constraint, so source in its dep FOD is
  # harmless. drishti shares ONE pnpmDeps across the monitor AND the narrow
  # agent derivation, so the FOD must be source-free or the agent would churn
  # on every app edit — the manifests-only fetch is what makes the sharing safe.
  pnpmSrc = lib.fileset.toSource {
    root = ./.;
    # MAINTENANCE INVARIANT: every workspace member's package.json must be
    # listed here. `fetchPnpmDeps` runs `pnpm install --frozen-lockfile`, which
    # validates each lockfile importer against a present manifest — add a new
    # `packages/*` member without adding its package.json here and the FOD fetch
    # fails in the sandbox. (Manifests ONLY: no package SOURCE belongs in this
    # fileset — that source-freedom is what keeps the FOD drv-stable; see above.)
    fileset = lib.fileset.unions [
      ./package.json
      ./pnpm-lock.yaml
      ./pnpm-workspace.yaml
      ./.npmrc
      ./packages/app/package.json
      ./packages/agent/package.json
      ./packages/common/package.json
    ];
  };
  pnpmDeps = resolvedPkgs.fetchPnpmDeps {
    pname = "drishti";
    version = "0.1.0";
    src = pnpmSrc;
    hash = "sha256-fmxzpOPKFjHfl0yt3T/li98PY8Q5BEsfMn6oHo7EuMA=";
    fetcherVersion = 3;
  };

  drishtiBuilt = resolvedPkgs.callPackage ./nix/packages/drishti {
    inherit pnpmDeps;
    surfaceAppCommit = rev;
  };

  # The agent's own minimal build tree. Scoped to packages/agent + the wire
  # contract so its `.drv` is invariant to client/server edits — the keystone
  # of issue #38. See nix/packages/drishti-agent/default.nix.
  drishtiAgentBuilt = resolvedPkgs.callPackage ./nix/packages/drishti-agent {
    inherit pnpmDeps;
  };

  drishti-agent = resolvedPkgs.runCommand "drishti-agent"
    {
      nativeBuildInputs = [ resolvedPkgs.makeWrapper ];
      meta.mainProgram = "drishti-agent";
    } ''
    mkdir -p $out/bin
    makeWrapper ${resolvedPkgs.tsx}/bin/tsx $out/bin/drishti-agent \
      --add-flags "${drishtiAgentBuilt}/lib/drishti/packages/agent/src/main.ts" \
      --prefix PATH : ${lib.makeBinPath [ resolvedPkgs.nodejs ]}
  '';

  drishti-client = resolvedPkgs.runCommand "drishti-client"
    {
      meta.description = "drishti browser bundle (static assets)";
    } ''
    cp -r ${drishtiBuilt}/lib/drishti/packages/app/dist $out
  '';

  drishti =
    if agentDrvBySystem == null
    then throw "the `drishti` monitor wrapper requires `agentDrvBySystem` — invoke via flake.nix (which threads in the per-system agent .drv map)"
    else
      resolvedPkgs.runCommand "drishti"
        {
          nativeBuildInputs = [ resolvedPkgs.makeWrapper ];
          meta.mainProgram = "drishti";
        } ''
        mkdir -p $out/bin
        makeWrapper ${resolvedPkgs.tsx}/bin/tsx $out/bin/drishti \
          --add-flags "${drishtiBuilt}/lib/drishti/packages/app/src/server/main.ts" \
          --set DRISHTI_DIST_DIR "${drishti-client}" \
          `# Same build commit injected onto the client's no-store HTML shell` \
          `# (above) as window.__SURFACE_APP_COMMIT__, so the server's buildInfo` \
          `# cell and the client's shellCommit() agree — the freshness rail` \
          `# reads one consistent commit.` \
          --set ${stamp.envVar} "${rev}" \
          `# DRISHTI_AGENT_DRVS_JSON: {system -> drvPath} JSON map. flake.nix` \
          `# pre-evaluates one entry per system in its 'systems' list; the` \
          `# server picks the right entry at runtime via 'uname -ms' on each` \
          `# host (see packages/app/src/server/archMap.ts). drvPath is a STRING` \
          `# interpolation, not a Nix dependency edge — rename the attribute` \
          `# and this wrapper compiles fine but HostSession crashes at` \
          `# 'nix copy --derivation' time.` \
          --set-default DRISHTI_AGENT_DRVS_JSON '${builtins.toJSON agentDrvBySystem}' \
          --prefix PATH : ${lib.makeBinPath [ resolvedPkgs.nodejs resolvedPkgs.openssh resolvedPkgs.nix ]}
      '';
in
{
  inherit drishti drishti-agent drishti-client drishtiBuilt drishtiAgentBuilt;
  inherit (resolvedPkgs) kolu-surface kolu-surface-nix-host;
}
