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
install:
    {{ nix_shell }} bun install
    {{ nix_shell }} sh -c 'sh scripts/hydrate-kolu-packages.sh \
      "$DRISHTI_KOLU_SURFACE" @kolu/surface \
      "$DRISHTI_KOLU_SURFACE_NIX_HOST" @kolu/surface-nix-host'

# Boot the parent server. Defaults host to localhost; pass a user@host to
# target a remote. Resolves the agent's `.drv` for the *target host's*
# architecture (probed via `ssh $host uname -ms`), then exports
# DRISHTI_AGENT_DRV so the parent's HostSession can ship the derivation
# to the host and realise it there.
dev host='localhost' *args: install
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{ host }}" = "localhost" ] || [ "{{ host }}" = "127.0.0.1" ]; then
      sys=$(nix eval --raw --impure --expr builtins.currentSystem)
    else
      uname_out=$(ssh -o BatchMode=yes {{ host }} uname -ms)
      case "$uname_out" in
        "Darwin arm64")  sys=aarch64-darwin ;;
        "Darwin x86_64") sys=x86_64-darwin ;;
        "Linux x86_64")  sys=x86_64-linux ;;
        "Linux aarch64") sys=aarch64-linux ;;
        *) echo "» unsupported remote uname: $uname_out" >&2; exit 1 ;;
      esac
    fi
    echo "» target host: {{ host }} (system=$sys)"
    drv=$(nix eval --raw "{{ justfile_directory() }}#packages.$sys.drishti-agent.drvPath")
    echo "» agent .drv:  $drv"
    DRISHTI_AGENT_DRV=$drv \
    {{ nix_shell }} bun --cwd packages/app dev {{ host }} {{ args }}

# TypeScript type checking
typecheck: install
    {{ nix_shell }} bun --cwd packages/app typecheck

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

# Build the wrapped monitor binary and print its store path.
nix-build:
    nix build .#default --print-out-paths --no-link

# Run the wrapped monitor binary directly.
nix-run *args:
    nix run .#default -- {{ args }}

# Remove all gitignored files (node_modules, build artifacts, etc.)
clean:
    git clean -fdX
