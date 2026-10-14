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
#   drishti-agent  — the remote-side binary. A host resolves it from the
#                     ASSEMBLED AGENT SOURCE (`agentFlakeSource` below, built
#                     from nix/agent-flake.nix) and realises it locally; the
#                     monitor bakes that source's flake ref and
#                     @kolu/surface-remote does the rest (juspay/kolu#2294).
#                     Wraps bun → packages/agent/src/main.ts, built by
#                     `drishtiAgentBuilt` (NOT the full `drishtiBuilt` tree — see
#                     nix/packages/drishti-agent/default.nix for why scoping the
#                     agent's inputs is the fix for the reconnect re-provision).
#
#   drishti-client — the static client bundle ($out is the dist dir).
#                     The monitor wrapper bakes DRISHTI_DIST_DIR to this.
#
#   drishti        — the monitor (default attr). Wraps bun →
#                     packages/app/src/server/main.ts; bakes
#                     SURFACE_AGENT_FLAKE_REF (the ONE agent declaration — the
#                     remote host resolves its agent from it; the caches ride
#                     the source's own `binary-cache.json` sidecar, derived from
#                     nix/agent-flake.nix's nixConfig), the agent identity pair
#                     and DRISHTI_DIST_DIR (drishti-client). meta.mainProgram is
#                     "drishti" so `nix run` resolves cleanly.
#
# `b2n` carries the bun2nix helpers; passed in from flake.nix via
# `lib.mkBun2nix { inherit pkgs; }` (juspay/bun2nix rawflake standalone API).
#
# Agent delivery is ONE declaration, not an env-var family: the agent source
# bakes `binary-cache.json` (caches + closure index) beside `commit-hash`, and
# @kolu/surface-remote reads both. Nothing here threads a system→drv map, a
# per-system build-id map or a cache URL into the monitor any more — the
# framework resolves `packages.<host-system>.drishti-agent` from the baked
# source itself, and the identity is platform-independent (below).
{ pkgs ? null
, b2n ? null
  # Navigable commit this build is stamped from: baked into the client bundle,
  # the server wrapper's freshness rail AND the agent's identity pair, from one
  # source (flake.nix passes `self.rev`). Defaults to "dev" for non-flake
  # (`nix-build`) invocations. `nix/agent-flake.nix` reads the same value back
  # out of the baked `commit-hash` file.
, commitHash ? "dev"
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
    then resolvedPkgs.callPackage ./nix/packages/drishti { bun2nix = b2n; surfaceAppCommit = commitHash; }
    else throw "drishti build derivation needs `b2n` (lib.mkBun2nix output) — invoke via flake.nix";

  # The agent's own minimal build tree. Scoped to packages/agent + the wire
  # contract so its `.drv` is invariant to client/server edits — the keystone
  # of issue #38. See nix/packages/drishti-agent/default.nix.
  drishtiAgentBuilt =
    if b2n != null
    then resolvedPkgs.callPackage ./nix/packages/drishti-agent { bun2nix = b2n; }
    else throw "drishti agent build derivation needs `b2n` (lib.mkBun2nix output) — invoke via flake.nix";

  # ── Agent delivery (juspay/kolu#2294 — the surface closure-delivery seam) ──
  kolu = (import ./npins).kolu;

  # The framework's own registry for the env-var NAME the wrapper bakes and
  # @kolu/surface-remote's `readBakedAgentSource()` reads. Reading it from the
  # pin keeps the two sides one edit apart instead of two literals that drift.
  agentEnv = resolvedPkgs.lib.importJSON "${kolu}/packages/surface-remote/agent-env.json";

  # WHICH closure IS the agent — one policy (nix/agent-fileset.nix), shared with
  # the derivation that builds it and with the identity below.
  agentFileset = import ./nix/agent-fileset.nix { inherit (resolvedPkgs) lib; };

  # The agent's currency key (`DRISHTI_AGENT_BUILD_ID`) — @kolu/surface-daemon's
  # ONE recipe, the Nix half of the `readBakedIdentity("DRISHTI_AGENT")` the
  # agent already calls. It hashes the SOURCE closure, so the id is
  # platform-INDEPENDENT: a macOS laptop and the linux host it dials bake the
  # SAME id, and convergence is a comparison rather than a per-system map that
  # can drift. `pinnedSources` carries the kolu pin: the `@kolu/*` packages the
  # agent hydrates arrive through it, so a pin bump moves the id exactly like a
  # source edit (and the repo's `just ci::drv-stability` probes pin both
  # directions).
  agentIdentity =
    (import "${kolu}/packages/surface-daemon/nix/daemon-identity.nix" {
      inherit (resolvedPkgs) lib;
    }) {
      name = "drishti-agent";
      prefix = "DRISHTI_AGENT";
      root = agentFileset.root;
      behavioralFileset = agentFileset.fileset;
      pinnedSources = { kolu = "${kolu}"; };
      commitHash = commitHash;
    };
  drishtiAgentBuildId = agentIdentity.buildId;

  # WHAT the assembled agent source carries: enough for the copied
  # nix/agent-flake.nix + default.nix to evaluate
  # `packages.<system>.drishti-agent` with no fetch beyond the locked bun2nix
  # input. Deliberately not the app — this store path is baked onto the monitor
  # wrapper and therefore rides the monitor's own closure.
  agentSourceTree = {
    root = ./.;
    fileset = resolvedPkgs.lib.fileset.unions [
      ./default.nix
      ./nix
      ./npins
      # The bun2nix input's lock, so the assembled flake evaluates offline
      # against whatever this machine already has (see nix/agent-flake.nix).
      ./flake.lock
      ./packages/agent
      ./packages/common
      ./scripts/hydrate-kolu-packages.sh
      ./tsconfig.base.json
    ];
  };

  # The flake-shaped agent source a remote resolves `drishti-agent` from — the
  # ONE thing flake.nix bakes as SURFACE_AGENT_FLAKE_REF, and what CI publishes
  # content-addressed (`publish-closures` in .github/workflows/nix-cache.yml).
  #
  # `mkAgentSourceTree` (assemble) rather than `mkProvenAgentSource` (assemble +
  # prove): the prove re-imports the assembled tree's own default.nix with
  # `{ pkgs, commitHash }`, and drishti's agent derivation needs bun2nix — which
  # reaches a tree only as a FLAKE INPUT, i.e. not at plain-import time. The
  # eval-time gate therefore lives where it can act: `just ci::agent-flake-nix`
  # evaluates every system's `drvPath` from this exact source, and the publisher
  # builds each exposed attr from it on every PR.
  agentFlakeSource =
    import "${kolu}/packages/surface-daemon/nix/agent-source-tree.nix" { inherit (resolvedPkgs) lib; } {
      pkgs = resolvedPkgs;
      name = "drishti-agent-source";
      src = resolvedPkgs.lib.fileset.toSource agentSourceTree;
      flakeNix = ./nix/agent-flake.nix;
      label = "drishti";
      # Where each system's content-addressed build is published, keyed by
      # `commit-hash` — a dial from a published revision has the host pull it
      # with NO trust (the `ca-index` branch is born on the first master run).
      closureIndex = { repo = "srid/drishti"; branch = "ca-index"; };
      extraFiles = { "commit-hash" = commitHash; };
    };

  # ONE wrapper. It used to be two (inner = bun+entry, outer = identity) so a
  # monorepo rev could not rotate the id; with the identity hashing SOURCE
  # instead of the inner `.drv`, that split buys nothing.
  drishti-agent = resolvedPkgs.runCommand "drishti-agent"
    {
      nativeBuildInputs = [ resolvedPkgs.makeWrapper ];
      meta.mainProgram = "drishti-agent";
    } ''
    mkdir -p $out/bin
    makeWrapper ${resolvedPkgs.bun}/bin/bun $out/bin/drishti-agent \
      --add-flags "${drishtiAgentBuilt}/lib/drishti/packages/agent/src/main.ts" \
      --set DRISHTI_OSFACTS_BIN "${resolvedPkgs.osfacts}/bin/osfacts" \
      `# The identity pair the supervisor reads (both-or-neither, UW5).` \
      ${agentIdentity.bakeArgs}
  '';

  drishti-client = resolvedPkgs.runCommand "drishti-client"
    {
      meta.description = "drishti browser bundle (static assets)";
    } ''
    cp -r ${drishtiBuilt}/lib/drishti/packages/app/dist $out
  '';

  drishti =
    if b2n == null
    then throw "the `drishti` monitor wrapper needs `b2n` (lib.mkBun2nix output) — invoke via flake.nix"
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
          --set ${stamp.envVar} "${commitHash}" \
          `# Expected agent identity for convergeAdmit (UW3) — the SAME pair the` \
          `# agent wrapper bakes. Platform-independent, so one value answers for` \
          `# every host arch: no per-system map, and a cross-arch host is not` \
          `# misread as a build mismatch.` \
          ${agentIdentity.bakeArgs} \
          `# SURFACE_AGENT_FLAKE_REF (the NAME comes from kolu's own agent-env` \
          `# registry): the assembled agent source a remote resolves` \
          `# 'packages.<host-system>.drishti-agent' from. A build fact, so --set,` \
          `# not --set-default — an ambient stale ref must never override it.` \
          `# Its sidecar carries the caches + closure index; nothing else about` \
          `# delivery is spelled here.` \
          --set ${agentEnv.flakeRef} "${agentFlakeSource}" \
          --prefix PATH : ${resolvedPkgs.lib.makeBinPath [ resolvedPkgs.openssh resolvedPkgs.nix ]}
      '';
in
{
  inherit drishti drishti-agent drishti-client drishtiBuilt drishtiAgentBuilt;
  inherit drishtiAgentBuildId agentFlakeSource;
  inherit (resolvedPkgs) kolu-surface kolu-surface-remote kolu-surface-map osfacts osfacts-client;
}
