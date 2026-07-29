# Root composer for drishti Nix derivations.
#
# The dev shell consumes `kolu-surface` + `kolu-surface-remote` +
# `kolu-surface-map` (via `nix/env.nix`); the wrappers below feed `nix run` /
# `nix build`.
#
# User-facing derivations. The monitor + client are backed by `drishtiBuilt`
# (the full app tree + client bundle); the agent is backed by its own minimal
# `drishtiAgentBuilt` so client/server edits don't churn its `.drv` (issue #38).
#
#   drishti-agent  — the remote-side binary. `nix copy --derivation` ships
#                     this .drv to the SSH target host, which realises it
#                     locally. Wraps bun → packages/agent/src/main.ts, built by
#                     `drishtiAgentBuilt` (NOT the full `drishtiBuilt` tree — see
#                     nix/packages/drishti-agent/default.nix for why scoping the
#                     agent's inputs is the fix for the reconnect re-provision).
#
#   drishti-client — the static client bundle ($out is the dist dir).
#                     The monitor wrapper bakes DRISHTI_DIST_DIR to this.
#
#   drishti        — the monitor (default attr). Wraps bun →
#                     packages/app/src/server/main.ts; bakes
#                     DRISHTI_AGENT_DRVS_JSON (system→drv map, sourced
#                     from flake.nix), DRISHTI_AGENT_BINARY_CACHE (the
#                     prefetch cache declaration, from flake.nix's
#                     nixConfig) and DRISHTI_DIST_DIR (drishti-client).
#                     meta.mainProgram is "drishti" so `nix run`
#                     resolves cleanly.
#
# `b2n` carries the bun2nix helpers; passed in from flake.nix via
# `lib.mkBun2nix { inherit pkgs; }` (juspay/bun2nix rawflake standalone API).
#
# `agentDrvBySystem` is the cross-system map flake.nix builds eagerly
# (drvPath is pure eval; no IFD) and threads in here so the monitor can
# pick the right agent at runtime per the remote host's `uname -ms`.
# Only the `drishti` monitor needs it — `drishti-agent` and
# `drishti-client` realize fine without it; throws on use if missing.
{ pkgs ? null
, b2n ? null
, agentDrvBySystem ? null
  # Per-system agent BUILD_ID map ({ system → hash }) for multi-arch
  # convergeAdmit. Same bake rules as agentDrvBySystem (string-only JSON).
, agentBuildIdBySystem ? null
  # Binary-cache declaration ({ substituters; trustedPublicKeys; } — lists,
  # both non-empty) baked for @kolu/surface-remote's agent prefetch. flake.nix
  # derives it from its own nixConfig block; like agentDrvBySystem, only the
  # `drishti` monitor needs it — throws on use if missing.
, binaryCache ? null
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
  # b2n is required for the `drishtiBuilt` derivation. When `default.nix`
  # is imported without it (e.g. `nix-build -A kolu-surface`), only the
  # overlay attrs are realizable. The build derivation throws on access
  # if needed without bun2nix wired up.
  drishtiBuilt =
    if b2n != null
    then resolvedPkgs.callPackage ./nix/packages/drishti { bun2nix = b2n; surfaceAppCommit = rev; }
    else throw "drishti build derivation needs `b2n` (lib.mkBun2nix output) — invoke via flake.nix";

  # The agent's own minimal build tree. Scoped to packages/agent + the wire
  # contract so its `.drv` is invariant to client/server edits — the keystone
  # of issue #38. See nix/packages/drishti-agent/default.nix.
  drishtiAgentBuilt =
    if b2n != null
    then resolvedPkgs.callPackage ./nix/packages/drishti-agent { bun2nix = b2n; }
    else throw "drishti agent build derivation needs `b2n` (lib.mkBun2nix output) — invoke via flake.nix";

  # Identity env for the durable daemon (UW3). BUILD_ID flips iff the agent
  # *closure* changes — the convergence kit's build-mismatch axis. It is a
  # pure hash of `drishtiAgentBuilt` so a client-only monorepo commit cannot
  # churn the agent wrapper (drv-stability / issue #38). Do NOT bake monorepo
  # `self.rev` into this wrapper — that would rehash the agent (and trigger a
  # fleet-wide drain) on every app edit. COMMIT_HASH stays unset here (reads
  # as "" / off-nix navigable identity via readBakedIdentity); the parent
  # wrapper still carries the monorepo rev for UI diagnostics.
  drishtiAgentBuildId = builtins.hashString "sha256" (toString drishtiAgentBuilt);
  drishti-agent = resolvedPkgs.runCommand "drishti-agent"
    {
      nativeBuildInputs = [ resolvedPkgs.makeWrapper ];
      meta.mainProgram = "drishti-agent";
    } ''
    mkdir -p $out/bin
    makeWrapper ${resolvedPkgs.bun}/bin/bun $out/bin/drishti-agent \
      --add-flags "${drishtiAgentBuilt}/lib/drishti/packages/agent/src/main.ts" \
      --set DRISHTI_OSFACTS_BIN "${resolvedPkgs.osfacts}/bin/osfacts" \
      --set DRISHTI_AGENT_BUILD_ID "${drishtiAgentBuildId}"
  '';

  drishti-client = resolvedPkgs.runCommand "drishti-client"
    {
      meta.description = "drishti browser bundle (static assets)";
    } ''
    cp -r ${drishtiBuilt}/lib/drishti/packages/app/dist $out
  '';

  drishti =
    if agentDrvBySystem == null || binaryCache == null
    then throw "the `drishti` monitor wrapper requires `agentDrvBySystem` and `binaryCache` — invoke via flake.nix (which threads in the per-system agent .drv map and the cache declaration)"
    else
      resolvedPkgs.runCommand "drishti"
        {
          nativeBuildInputs = [ resolvedPkgs.makeWrapper ];
          meta.mainProgram = "drishti";
        } ''
        mkdir -p $out/bin
        makeWrapper ${resolvedPkgs.bun}/bin/bun $out/bin/drishti \
          --add-flags "${drishtiBuilt}/lib/drishti/packages/app/src/server/main.ts" \
          --set DRISHTI_DIST_DIR "${drishti-client}" \
          `# Same build commit injected onto the client's no-store HTML shell` \
          `# (above) as window.__SURFACE_APP_COMMIT__, so the server's buildInfo` \
          `# cell and the client's shellCommit() agree — the freshness rail` \
          `# reads one consistent commit.` \
          --set ${stamp.envVar} "${rev}" \
          `# Expected agent build identity for convergeAdmit (UW3). Same hash` \
          `# the agent wrapper bakes; multi-arch remotes may mismatch and` \
          `# ride adopt-stale after the drain budget (onGiveUp).` \
          --set DRISHTI_AGENT_BUILD_ID "${drishtiAgentBuildId}" \
          --set DRISHTI_AGENT_COMMIT_HASH "${rev}" \
          `# DRISHTI_AGENT_DRVS_JSON: {system -> drvPath} JSON map. flake.nix` \
          `# pre-evaluates one entry per system in its 'systems' list; the` \
          `# server picks the right entry at runtime via 'uname -ms' on each` \
          `# host (see packages/app/src/server/archMap.ts). drvPath is a STRING` \
          `# interpolation, not a Nix dependency edge — rename the attribute` \
          `# and this wrapper compiles fine but HostSession crashes at` \
          `# 'nix copy --derivation' time.` \
          --set-default DRISHTI_AGENT_DRVS_JSON '${builtins.toJSON agentDrvBySystem}' \
          `# Per-system BUILD_IDs so multi-arch hosts expect the agent they` \
          `# provision (not the parent-arch-only DRISHTI_AGENT_BUILD_ID).` \
          --set-default DRISHTI_AGENT_BUILD_IDS_JSON '${builtins.toJSON (if agentBuildIdBySystem != null then agentBuildIdBySystem else {})}' \
          `# DRISHTI_AGENT_BINARY_CACHE: {substituters, trustedPublicKeys}` \
          `# JSON (surface-remote's AgentBinaryCache shape) — the caches the` \
          `# agent closure is prefetched from before shipping to a remote` \
          `# host. Sourced from flake.nix's nixConfig block, so the cache CI` \
          `# pushes builds to is the cache provisioning pulls from.` \
          --set-default DRISHTI_AGENT_BINARY_CACHE '${builtins.toJSON binaryCache}' \
          --prefix PATH : ${resolvedPkgs.lib.makeBinPath [ resolvedPkgs.openssh resolvedPkgs.nix ]}
      '';
in
{
  inherit drishti drishti-agent drishti-client drishtiBuilt drishtiAgentBuilt;
  inherit (resolvedPkgs) kolu-surface kolu-surface-remote kolu-surface-map osfacts osfacts-client;
}
