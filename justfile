# Use git+file:// (default) instead of path: — path: disables the eval cache
# and re-copies/re-evaluates on every invocation. Caveat: new .nix files must
# be `git add`ed before nix develop sees them.
nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop ' + justfile_directory() + ' --accept-flake-config -c' }

mod ci 'ci/mod.just'

# List available recipes
default:
    @just --list

# Install dependencies (bun) and hydrate @kolu/* packages from the nix store.
# The hydrate call is wrapped in `sh -c '...'` so `$DRISHTI_KOLU_SURFACE*`
# expand *inside* the nix-develop shell that exports them, not by just's
# outer shell (which runs under `set -u` and errors on the unset vars if
# the user invokes `just install` from a non-direnv terminal).
#
# @kolu/surface-app (the app shell) is hydrated the same way — its raw .ts is
# consumed directly (no build step). DRAFT-PR NOTE: it is not yet pinned via
# npins, so DRISHTI_KOLU_SURFACE_APP is defaulted to a LOCAL kolu worktree here.
# For the real PR, add surface-app to npins (kolu source) + nix/env.nix exactly
# like the other two and drop the `:-` default below.
surface_app_src := env('DRISHTI_KOLU_SURFACE_APP', '/home/srid/code/kolu/.worktrees/reload-error/packages/surface-app')
install:
    {{ nix_shell }} bun install
    {{ nix_shell }} sh -c 'sh scripts/hydrate-kolu-packages.sh \
      "$DRISHTI_KOLU_SURFACE" @kolu/surface \
      "$DRISHTI_KOLU_SURFACE_NIX_HOST" @kolu/surface-nix-host'
    # DRAFT-PR ONLY: stage a CLEAN copy of the local surface-app worktree
    # (its `src` + package.json — never its node_modules/example, which carry
    # cyclic workspace symlinks `cp -rL` chokes on), then hydrate from that.
    # The eventual npins/nix-store source is already clean, so this staging
    # step disappears with the `:-` default in `surface_app_src` above.
    {{ nix_shell }} sh -c 'stage=$(mktemp -d); \
      cp -rL "{{ surface_app_src }}/src" "$stage/src"; \
      cp -L "{{ surface_app_src }}/package.json" "$stage/package.json"; \
      sh scripts/hydrate-kolu-packages.sh "$stage" @kolu/surface-app; \
      rm -rf "$stage"'

# Boot the parent server. Defaults to localhost; pass any number of
# user@host targets after it. Exports DRISHTI_AGENT_DRVS_JSON (the
# per-system agent .drv map from the flake) so the parent can probe each
# host's arch on add and pick the matching .drv — no shell-side probe.
dev host='localhost' *args: install
    #!/usr/bin/env bash
    set -euo pipefail
    drvs_json=$(nix eval --raw "{{ justfile_directory() }}#agentDrvsJson")
    echo "» agent drvs: $drvs_json"
    DRISHTI_AGENT_DRVS_JSON="$drvs_json" \
    {{ nix_shell }} bun --cwd packages/app dev {{ host }} {{ args }}

# TypeScript type checking (every workspace member: common, agent, app)
typecheck: install
    {{ nix_shell }} bun run typecheck

# Format all *.nix files (and any future biome target — drishti doesn't
# bring biome in by default; add when JS formatting becomes a chore).
fmt:
    {{ nix_shell }} nixpkgs-fmt .

# Check formatting without modifying (used by CI)
fmt-check:
    {{ nix_shell }} nixpkgs-fmt --check .

# Regenerate bun.nix from bun.lock. Run this after any change to bun.lock
# (i.e. after `bun install`/`bun add`).
regenerate-bun-nix:
    {{ nix_shell }} sh -c 'nix run .#bun2nix -- -l bun.lock -o bun.nix && nixpkgs-fmt bun.nix'

# Regenerate the committed PWA icons (manifest icons, favicon, apple-touch)
# from scripts/gen-pwa-icons.ts. Run this after editing the icon geometry.
gen-pwa-icons:
    {{ nix_shell }} bun scripts/gen-pwa-icons.ts

# Build the wrapped monitor binary and print its store path.
nix-build:
    nix build .#default --print-out-paths --no-link

# Run the wrapped monitor binary directly.
nix-run *args:
    nix run .#default -- {{ args }}

# Remove all gitignored files (node_modules, build artifacts, etc.)
clean:
    git clean -fdX
