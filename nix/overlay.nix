# Exposes kolu workspace packages as Nix-store sources.
#
# Several leaves today (surface, surface-remote, surface-map, shell-quote,
# surface-app, solid-pwa-install). A new arrival is a one-line addition:
# `kolu-foo = mkKoluPackage "foo";`. The factory keeps
# the recipe single-sourced; the per-leaf overlay entry keeps each
# package's volatility axis independently encapsulated.
final: _prev:
let
  mkKoluPackage = import ./packages/kolu-package.nix { pkgs = final; };
  kolu = (import ../npins).kolu;
in
{
  kolu-surface = mkKoluPackage "surface";
  # Renamed from `surface-nix-host` upstream (juspay/kolu surface-map
  # adoption) — the remote-session + host-pool machinery now lives in
  # `@kolu/surface-remote`.
  kolu-surface-remote = mkKoluPackage "surface-remote";
  # The keyed dynamic-map framework (`defineSurfaceMap`/`serveSurfaceMap`/
  # `connectSurfaceMap`) drishti's fleet view now consumes for host
  # membership + status, replacing the hand-rolled `hostRegistry.ts` +
  # `admin-surface.ts` host collection.
  kolu-surface-map = mkKoluPackage "surface-map";
  kolu-surface-app = mkKoluPackage "surface-app";
  # The install-card adapter; shipped via juspay/kolu#1199 (merged to master).
  kolu-solid-pwa-install = mkKoluPackage "solid-pwa-install";
  # The zero-dep POSIX shell-quote leaf surface-remote imports (kolu P2,
  # juspay/kolu#1439) — hydrated so its `@kolu/shell-quote` import resolves.
  kolu-shell-quote = mkKoluPackage "shell-quote";
  # The zero-dep logging leaf surface-remote imports (the `log:Logger` seam,
  # juspay/kolu#1876) — hydrated so its `@kolu/log` import resolves.
  kolu-log = mkKoluPackage "log";
  # osfacts incubates at the kolu repo root (juspay/kolu#2011), outside the
  # `packages/` workspace. Keep its binary and dependency-free TypeScript
  # client on the same npins revision so the client's `V 2` gate can never be
  # paired with a binary from another source.
  osfacts = import (kolu + "/osfacts") { pkgs = final; };
  osfacts-client = final.runCommand "osfacts-client"
    {
      meta = {
        description = "TypeScript client source for osfacts";
        homepage = "https://github.com/juspay/kolu/tree/osfacts-improve/osfacts/client-ts";
      };
    }
    ''
      cp -r ${kolu}/osfacts/client-ts $out
    '';
}
