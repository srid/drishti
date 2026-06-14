# IMPORTANT: this flake intentionally has ZERO inputs (the kolu/odu
# convention). nixpkgs and the kolu pin (for @kolu/surface, @kolu/surface-app,
# @kolu/surface-nix-host) are managed by npins (see npins/sources.json) and
# imported via fetchTarball, keeping `nix develop` cold-eval fast (~1.0s vs ~7s
# per flake input). DO NOT add flake inputs — deps come through npins.
#
# The Node toolchain (pnpm + tsx + vite) is packaged with nixpkgs' own
# `fetchPnpmDeps` / `pnpmConfigHook` (see default.nix), the way juspay/odu does
# it — so there is no bun2nix input to special-case anymore.
{
  outputs = { self, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = system:
        let pkgs = import ./nix/nixpkgs.nix { inherit system; };
        in { inherit pkgs; };
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
        (_: { pkgs }:
          builtins.unsafeDiscardStringContext
            (import ./default.nix { inherit pkgs; }).drishti-agent.drvPath)
        perSystemAttrs;
    in
    {
      packages = eachSystem ({ pkgs }:
        let
          drvs = import ./default.nix { inherit pkgs agentDrvBySystem rev; };
        in
        {
          # `nix run github:srid/drishti -- user@host` → the monitor.
          default = drvs.drishti;
          inherit (drvs) drishti drishti-agent drishti-client drishtiBuilt drishtiAgentBuilt;
          # @kolu/* source paths — exposed so `nix build .#kolu-surface`
          # realizes the store path used by the dev shell's hydrate hook.
          kolu-surface = pkgs.kolu-surface;
          kolu-surface-nix-host = pkgs.kolu-surface-nix-host;
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
      formatter = eachSystem ({ pkgs }: pkgs.nixpkgs-fmt);

      devShells = eachSystem ({ pkgs }:
        {
          default = import ./shell.nix { inherit pkgs; };
        });
    };
}
