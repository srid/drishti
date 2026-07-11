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
      rev = stamp.revFromSelf self;

      # Per-system `drishti-agent.drvPath`. Pure eval — drvPath is just a
      # string interpolation, not a built output — so a macOS evaluator
      # can produce the linux .drv path without IFD or remote builders.
      # The monitor wrapper bakes this entire map as JSON; the server
      # picks the right entry per host at runtime via `uname -ms`.
      #
      # `unsafeDiscardStringContext` strips the closure-edge each drvPath
      # carries. Without it, baking the JSON into the monitor wrapper
      # would pull every system's drishti-agent.drv into the wrapper's
      # closure, and realising the wrapper on (say) x86_64-linux would
      # need an aarch64-linux builder — defeating the whole point of
      # deferring agent realisation to the remote host.
      agentDrvBySystem = builtins.mapAttrs
        (_: { pkgs, b2n }:
          builtins.unsafeDiscardStringContext
            (import ./default.nix { inherit pkgs b2n; }).drishti-agent.drvPath)
        perSystemAttrs;
    in
    {
      packages = eachSystem ({ pkgs, b2n }:
        let
          drvs = import ./default.nix { inherit pkgs b2n agentDrvBySystem rev; };

        in
        {
          # `nix run github:srid/drishti -- user@host` → the monitor.
          default = drvs.drishti;
          inherit (drvs) drishti drishti-agent drishti-client drishtiBuilt drishtiAgentBuilt;
          # @kolu/* source paths — exposed so `nix build .#kolu-surface`
          # realizes the store path used by the dev shell's hydrate hook.
          kolu-surface = pkgs.kolu-surface;
          kolu-surface-remote = pkgs.kolu-surface-remote;
          kolu-surface-map = pkgs.kolu-surface-map;
          # bun2nix CLI — `nix run .#bun2nix -- -l bun.lock -o bun.nix`
          # regenerates the lockfile-derived nix expression.
          bun2nix = b2n.bun2nix;
        });

      # Top-level (system-independent) — the JSON shape the monitor reads
      # at runtime. `just dev` exports this verbatim as
      # DRISHTI_AGENT_DRVS_JSON without having to know about the per-
      # system attr structure.
      agentDrvsJson = builtins.toJSON agentDrvBySystem;

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
