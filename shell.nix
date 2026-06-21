# Dev shell — shared by `nix develop` (via flake.nix) and `nix-shell`.
{ pkgs ? import ./nix/nixpkgs.nix { } }:
let
  drishtiEnv = import ./nix/env.nix { inherit pkgs; };
in
pkgs.mkShell {
  name = "drishti-shell";

  # `@tailwindcss/cli` transitively dlopen()s `@parcel/watcher`'s native
  # binding, which requires `libstdc++.so.6` at runtime. Expose stdenv's
  # libstdc++ on LD_LIBRARY_PATH for both `bun install` (lifecycle
  # scripts) and the dev server's `buildClient` shell-out.
  env = drishtiEnv // {
    LD_LIBRARY_PATH = "${pkgs.stdenv.cc.cc.lib}/lib";
  };

  shellHook = ''
    # Hydrate node_modules/@kolu/{surface,surface-nix-host,surface-app,solid-pwa-install}
    # from the nix store. Hydration strategy lives in scripts/hydrate-kolu-packages.sh
    # — one script, three callers (this shellHook, the just `install`
    # recipe, and the drishti build derivation's
    # postBunNodeModulesInstallPhase).
    if root=$(git rev-parse --show-toplevel 2>/dev/null); then
      (cd "$root" && sh scripts/hydrate-kolu-packages.sh \
        "$DRISHTI_KOLU_SURFACE" @kolu/surface \
        "$DRISHTI_KOLU_SURFACE_NIX_HOST" @kolu/surface-nix-host \
        "$DRISHTI_KOLU_SHELL_QUOTE" @kolu/shell-quote \
        "$DRISHTI_KOLU_SURFACE_APP" @kolu/surface-app \
        "$DRISHTI_KOLU_SOLID_PWA_INSTALL" @kolu/solid-pwa-install)
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
