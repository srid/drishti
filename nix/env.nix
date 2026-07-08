# Env vars whose values are Nix-store paths — used by the dev shell and
# the build derivation. Other drishti env vars (DRISHTI_AGENT_DRVS_JSON,
# DRISHTI_DIST_DIR, DRISHTI_STATE_DIR if it ever appears) live closer
# to their consumer because they depend on runtime values; this file is
# strictly for store-path env.
#
#   DRISHTI_KOLU_SURFACE          — /nix/store path to @kolu/surface source.
#   DRISHTI_KOLU_SURFACE_REMOTE   — /nix/store path to @kolu/surface-remote
#                                    source (the remote-session + host-pool
#                                    machinery; renamed upstream from
#                                    @kolu/surface-nix-host).
#   DRISHTI_KOLU_SURFACE_MAP      — /nix/store path to @kolu/surface-map
#                                    source (the keyed dynamic-map framework —
#                                    defineSurfaceMap/serveSurfaceMap/
#                                    connectSurfaceMap — behind the fleet's
#                                    host membership + status).
#   DRISHTI_KOLU_SURFACE_APP      — /nix/store path to @kolu/surface-app source.
#   DRISHTI_KOLU_SOLID_PWA_INSTALL — /nix/store path to @kolu/solid-pwa-install
#                                    source (the install-card adapter; TODO(pin)).
#   DRISHTI_KOLU_SHELL_QUOTE      — /nix/store path to @kolu/shell-quote source
#                                    (the zero-dep POSIX leaf surface-remote imports).
#
# All are hydrated into node_modules/@kolu/{surface,surface-remote,surface-map,shell-quote,surface-app,solid-pwa-install}
# by scripts/hydrate-kolu-packages.sh (three callers: shell.nix
# shellHook, the justfile install recipe, and the build derivations'
# postBunNodeModulesInstallPhase).
{ pkgs }:
{
  DRISHTI_KOLU_SURFACE = pkgs.kolu-surface;
  DRISHTI_KOLU_SURFACE_REMOTE = pkgs.kolu-surface-remote;
  DRISHTI_KOLU_SURFACE_MAP = pkgs.kolu-surface-map;
  DRISHTI_KOLU_SURFACE_APP = pkgs.kolu-surface-app;
  DRISHTI_KOLU_SOLID_PWA_INSTALL = pkgs.kolu-solid-pwa-install;
  DRISHTI_KOLU_SHELL_QUOTE = pkgs.kolu-shell-quote;
}
