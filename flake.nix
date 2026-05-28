# IMPORTANT: zero flake inputs *except* `bun2nix` — anywhen convention.
# nixpkgs and kolu (for @kolu/surface, @kolu/surface-nix-host) are pinned
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

  outputs = { self, bun2nix, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      eachSystem = f: builtins.listToAttrs (map
        (system:
          let
            pkgs = import ./nix/nixpkgs.nix { inherit system; };
            b2n = bun2nix.lib.mkBun2nix { inherit pkgs; };
          in
          {
            name = system;
            value = f { inherit pkgs b2n; };
          })
        systems);
    in
    {
      packages = eachSystem ({ pkgs, b2n }:
        let drvs = import ./default.nix { inherit pkgs b2n; };
        in {
          # `nix run github:srid/drishti -- user@host` → the monitor.
          default = drvs.drishti;
          inherit (drvs) drishti drishti-agent drishti-client drishtiBuilt;
          # @kolu/* source paths — exposed so `nix build .#kolu-surface`
          # realizes the store path used by the dev shell's hydrate hook.
          kolu-surface = pkgs.kolu-surface;
          kolu-surface-nix-host = pkgs.kolu-surface-nix-host;
          # bun2nix CLI — `nix run .#bun2nix -- -l bun.lock -o bun.nix`
          # regenerates the lockfile-derived nix expression.
          bun2nix = b2n.bun2nix;
        });

      # `nix fmt` — format *.nix files only.
      formatter = eachSystem ({ pkgs, ... }: pkgs.nixpkgs-fmt);

      devShells = eachSystem ({ pkgs, b2n }:
        {
          default = import ./shell.nix { inherit pkgs; };
        });
    };
}
