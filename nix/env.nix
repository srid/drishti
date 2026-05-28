# Env vars whose values are Nix-store paths — used by the dev shell and
# the build derivation. Other drishti env vars (DRISHTI_AGENT_DRVS_JSON,
# DRISHTI_DIST_DIR, DRISHTI_STATE_DIR if it ever appears) live closer
# to their consumer because they depend on runtime values; this file is
# strictly for store-path env.
#
#   DRISHTI_KOLU_SURFACE          — /nix/store path to @kolu/surface source.
#   DRISHTI_KOLU_SURFACE_NIX_HOST — /nix/store path to @kolu/surface-nix-host
#                                    source.
#
# Both are hydrated into node_modules/@kolu/{surface,surface-nix-host}
# by scripts/hydrate-kolu-packages.sh (three callers: shell.nix
# shellHook, the justfile install recipe, and the build derivations'
# postBunNodeModulesInstallPhase).
{ pkgs }:
{
  DRISHTI_KOLU_SURFACE = pkgs.kolu-surface;
  DRISHTI_KOLU_SURFACE_NIX_HOST = pkgs.kolu-surface-nix-host;
}
