# Exposes kolu workspace packages as Nix-store sources.
#
# Several leaves today (surface, surface-nix-host, shell-quote, surface-app,
# solid-pwa-install). A new arrival is a one-line addition: `kolu-foo =
# mkKoluPackage "foo";`. The factory keeps
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
  # The install-card adapter; shipped via juspay/kolu#1199 (merged to master).
  kolu-solid-pwa-install = mkKoluPackage "solid-pwa-install";
  # The zero-dep POSIX shell-quote leaf surface-nix-host imports (kolu P2,
  # juspay/kolu#1439) — hydrated so its `@kolu/shell-quote` import resolves.
  kolu-shell-quote = mkKoluPackage "shell-quote";
}
