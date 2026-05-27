# Exposes kolu workspace packages as Nix-store sources.
#
# Two leaves today (surface, surface-nix-host). A third arrival is a
# one-line addition: `kolu-foo = mkKoluPackage "foo";`. The factory keeps
# the recipe single-sourced; the per-leaf overlay entry keeps each
# package's volatility axis independently encapsulated.
final: _prev:
let
  mkKoluPackage = import ./packages/kolu-package.nix { pkgs = final; };
in
{
  kolu-surface = mkKoluPackage "surface";
  kolu-surface-nix-host = mkKoluPackage "surface-nix-host";
}
