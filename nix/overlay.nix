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
  # osfacts owns a Rust MSRV/toolchain axis that drishti's TypeScript packages
  # do not. Build it with the exact nixpkgs pin Kolu tests it against; importing
  # its default.nix with drishti's older package set paired sysinfo 0.39.6
  # (MSRV 1.95) with rustc 1.93 on Darwin.
  koluPkgs = import (kolu + "/nix/nixpkgs.nix") {
    system = final.stdenv.hostPlatform.system;
  };
  # osfacts graduated out of the kolu tree into its own repo at OSF5
  # (juspay/kolu#2093); `kolu + "/osfacts"` no longer exists. Read it from
  # KOLU'S OWN npins pin rather than adding a second drishti pin, so the
  # binary and its client can never be a revision kolu does not test against
  # — the same one-revision invariant the in-tree directory used to give for
  # free.
  osfactsSrc = (import (kolu + "/npins")).osfacts;
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
  # Durable-daemon spine (UW3): the agent binary depends on surface-daemon
  # (daemonHome / daemonMain / front / controlCore); the parent depends on
  # surface-daemon-supervisor (convergeAdmit / probeDaemonIdentityFrom).
  # Both ride the same npins kolu pin so the fragment and the probe stay matched.
  kolu-surface-daemon = mkKoluPackage "surface-daemon";
  kolu-surface-daemon-supervisor = mkKoluPackage "surface-daemon-supervisor";
  # osfacts (juspay/osfacts, formerly the kolu repo root — see `osfactsSrc`).
  # Binary and dependency-free TypeScript client come from one revision, so
  # the client's `V 2` gate can never be paired with a binary from another
  # source.
  osfacts = import osfactsSrc { pkgs = koluPkgs; };
  osfacts-client = final.runCommand "osfacts-client"
    {
      meta = {
        description = "TypeScript client source for osfacts";
        homepage = "https://github.com/juspay/osfacts/tree/main/client-ts";
      };
    }
    ''
      cp -r ${osfactsSrc}/client-ts $out
    '';
}
