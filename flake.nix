# IMPORTANT: zero flake inputs *except* `bun2nix` — anywhen convention.
# nixpkgs and kolu (for @kolu/surface, @kolu/surface-remote, @kolu/surface-map) are pinned
# via npins (see npins/sources.json), bypassing the flake input system to
# keep `nix develop` cold-eval fast (~1.0s vs ~7s per input). DO NOT add
# further flake inputs.
#
# `bun2nix` is the documented exception: there is no fetchBunDeps /
# buildBunPackage in nixpkgs, and bun2nix's nix layer is flake-parts-
# shaped — it cannot be cleanly imported from a non-flake-parts context.
# juspay/bun2nix's `rawflake` branch exposes `lib.mkBun2nix { pkgs }` so
# we feed it OUR npins-pinned pkgs (no transitive nixpkgs eval in our
# flake). The input is only realized when the `packages.*` attrset is
# evaluated — `nix develop` cold eval stays unchanged.
{
  inputs.bun2nix.url = "github:juspay/bun2nix/rawflake";

  # Pull prebuilt closures from Juspay's shared OSS Attic cache. CI (see
  # .github/workflows/nix-cache.yml) pushes each build here, warming both CI
  # and local `nix build`s.
  nixConfig = {
    extra-substituters = "https://cache.nixos.asia/oss";
    extra-trusted-public-keys = "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=";
  };

  outputs = { self, bun2nix, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = system:
        let
          pkgs = import ./nix/nixpkgs.nix { inherit system; };
          b2n = bun2nix.lib.mkBun2nix { inherit pkgs; };
        in
        { inherit pkgs b2n; };
      perSystemAttrs = builtins.listToAttrs (map
        (system: { name = system; value = perSystem system; })
        systems);
      eachSystem = f: builtins.mapAttrs (_: ctx: f ctx) perSystemAttrs;

      # surface-app's build-commit Nix helper — the upstream single source for
      # the env-var name and the `self.rev → short → "dev"` resolution. We
      # compose it instead of re-deriving the rev logic downstream.
      stamp = import ((import ./npins).kolu + "/packages/surface-app/nix/commit-stamp.nix") { };

      # The build commit, stamped into BOTH the client bundle (the build
      # derivation's SURFACE_APP_COMMIT env) and the server wrapper, so the
      # freshness rail shows one consistent `srv · client` commit rather than
      # a sandbox-built `dev` client beside a git-resolved server. The rev
      # resolution (clean tree → short rev; dirty/non-flake → "dev") now comes
      # from surface-app's commit-stamp.nix rather than being repeated here.
      commitHash = stamp.revFromSelf self;

      # The agent's baked BUILD_ID. Platform-independent BY CONSTRUCTION — it
      # hashes the agent's SOURCE closure, not a derivation (see
      # `mkDaemonIdentity` in default.nix) — so ONE value answers for every
      # system: no per-system map for the monitor to select from, and a
      # cross-arch host is a comparison rather than a special case. Computed
      # once, from one system's pkgs (only `lib.fileset` is needed).
      agentBuildId = (import ./default.nix {
        pkgs = perSystemAttrs."x86_64-linux".pkgs;
        inherit commitHash;
      }).drishtiAgentBuildId;
    in
    {
      packages = eachSystem ({ pkgs, b2n }:
        let
          drvs = import ./default.nix { inherit pkgs b2n commitHash; };

        in
        {
          # `nix run github:srid/drishti -- user@host` → the monitor.
          default = drvs.drishti;
          inherit (drvs) drishti drishti-agent drishti-client drishtiBuilt drishtiAgentBuilt;
          # The ASSEMBLED agent source — what a remote resolves the agent from,
          # what the monitor bakes as SURFACE_AGENT_FLAKE_REF, and the `source:`
          # input of the `publish-closures` CI job (which reads its
          # `binary-cache.json` + `commit-hash` for the cache, the index and the
          # revision key). Exposed per system because the copy step is a
          # derivation, though its contents are system-independent.
          agent-flake-source = drvs.agentFlakeSource;
          # @kolu/* source paths — exposed so `nix build .#kolu-surface`
          # realizes the store path used by the dev shell's hydrate hook.
          kolu-surface = pkgs.kolu-surface;
          kolu-surface-remote = pkgs.kolu-surface-remote;
          kolu-surface-map = pkgs.kolu-surface-map;
          # Process/socket fact sampler + its zero-dependency TypeScript face,
          # pinned together from kolu's unmerged osfacts-plan branch.
          osfacts = pkgs.osfacts;
          osfacts-client = pkgs.osfacts-client;
          # bun2nix CLI — `nix run .#bun2nix -- -l bun.lock -o bun.nix`
          # regenerates the lockfile-derived nix expression.
          bun2nix = b2n.bun2nix;
        });

      # The agent identity the monitor expects, system-independent (see above).
      # `just dev` exports it as DRISHTI_AGENT_BUILD_ID, `just ci::drv-stability`
      # probes it, and the wrapper bakes it — one value, three readers.
      inherit agentBuildId;

      # home-manager module — runs the monitor as a systemd user service on
      # Linux and a launchd LaunchAgent on macOS. System-independent; the
      # consumer supplies `services.drishti.package` per their system.
      homeManagerModules.default = import ./nix/home/module.nix;

      # `nix fmt` — format *.nix files only.
      formatter = eachSystem ({ pkgs, ... }: pkgs.nixpkgs-fmt);

      devShells = eachSystem ({ pkgs, b2n }:
        {
          default = import ./shell.nix { inherit pkgs; };
        });
    };
}
