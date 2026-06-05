# Exposes kolu workspace packages as Nix-store sources.
#
# Three leaves today (surface, surface-nix-host, surface-app). A fourth
# arrival is a one-line addition: `kolu-foo = mkKoluPackage "foo";`. The factory keeps
# the recipe single-sourced; the per-leaf overlay entry keeps each
# package's volatility axis independently encapsulated.
final: _prev:
let
  mkKoluPackage = import ./packages/kolu-package.nix { pkgs = final; };
in
{
  kolu-surface = mkKoluPackage "surface";
  kolu-surface-nix-host = mkKoluPackage "surface-nix-host";
  kolu-surface-app = mkKoluPackage "surface-app";
  # TODO(pin): the install-card adapter. Lands once the kolu pin tracks a
  # revision where `packages/solid-pwa-install/src/index.tsx` exists (the
  # `welcome` PR — it is scaffolded but unimplemented on the current pin).
  kolu-solid-pwa-install = mkKoluPackage "solid-pwa-install";
}
