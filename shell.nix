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

  # Dependency hydration belongs to `just install`. A shell hook also runs for
  # every parallel CI command and would delete packages another check reads.

  packages = with pkgs; [
    just
    jq
    bun
    nixpkgs-fmt
    openssh
    nix
  ];
}
