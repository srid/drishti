# Dev shell — shared by `nix develop` (via flake.nix) and `nix-shell`.
{ pkgs ? import ./nix/nixpkgs.nix { } }:
let
  drishtiEnv = import ./nix/env.nix { inherit pkgs; };
in
pkgs.mkShell {
  name = "drishti-shell";

  env = drishtiEnv;

  shellHook = ''
    # Hydrate node_modules/@kolu/{surface,surface-nix-host} from the nix
    # store. Hydration strategy lives in scripts/hydrate-kolu-packages.sh
    # — one script, three callers (this shellHook, the just `install`
    # recipe, and the drishti build derivation's
    # postBunNodeModulesInstallPhase).
    if root=$(git rev-parse --show-toplevel 2>/dev/null); then
      (cd "$root" && sh scripts/hydrate-kolu-packages.sh \
        "$DRISHTI_KOLU_SURFACE" @kolu/surface \
        "$DRISHTI_KOLU_SURFACE_NIX_HOST" @kolu/surface-nix-host)
    fi
  '';

  packages = with pkgs; [
    just
    jq
    bun
    nixpkgs-fmt
    openssh
    nix
  ];
}
