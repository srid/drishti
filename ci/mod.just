# drishti CI pipeline — consumed by github:juspay/justci.
#
# The runner discovers the recipe tagged [metadata("ci")] (exactly one across
# this justfile and its submodules), expands its reachable dependency subgraph,
# and fans every (recipe × platform) pair out into a process-compose node.

set working-directory := '..'

# Re-enter nix devShell when the runner ssh's into a remote that doesn't have
# the project's dev tools on PATH. Skipped when already inside the shell.
nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop --accept-flake-config -c' }

# Pipeline root: every recipe listed here becomes a (recipe × platform) node.
[linux]
[macos]
[parallel]
[metadata("ci")]
default: nix typecheck fmt-check bun-nix-fresh

# Single per-platform `bun install`. Funnel every bun consumer through this
# node so concurrent `bun install` runs against the same workspace don't race.
# The hydrate call is wrapped in `sh -c '...'` so `$DRISHTI_KOLU_*` is
# expanded inside the nix-develop shell that exports it, not by just's outer
# shell (which runs under `set -u`).
install:
    {{ nix_shell }} bun install
    {{ nix_shell }} sh -c 'sh scripts/hydrate-kolu-packages.sh \
      "$DRISHTI_KOLU_SURFACE" @kolu/surface \
      "$DRISHTI_KOLU_SURFACE_NIX_HOST" @kolu/surface-nix-host'

# Build all flake outputs via devour-flake.
nix:
    nix build github:srid/devour-flake -L --no-link --print-out-paths --override-input flake .

# TypeScript type checking
typecheck: install
    {{ nix_shell }} bun --cwd packages/app typecheck

# Check formatting without modifying (nixpkgs-fmt). Accepts a directory
# argument and recurses, so `.` covers every *.nix at any depth.
fmt-check:
    {{ nix_shell }} nixpkgs-fmt --check .

# bun.nix freshness — regenerate from bun.lock into a tmpdir and diff
# against the committed file. Fails the pipeline if bun.lock has moved
# without `just regenerate-bun-nix` being run.
bun-nix-fresh:
    {{ nix_shell }} sh -c '\
      set -eu; \
      tmp=$(mktemp -d); \
      trap "rm -rf $tmp" EXIT; \
      nix run .#bun2nix -- -l bun.lock -o "$tmp/bun.nix"; \
      nixpkgs-fmt "$tmp/bun.nix" >/dev/null; \
      diff -u bun.nix "$tmp/bun.nix" || { \
        echo; \
        echo "bun.nix is stale relative to bun.lock."; \
        echo "Run: just regenerate-bun-nix && git add bun.nix"; \
        exit 1; \
      }'
