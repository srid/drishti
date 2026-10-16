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
# The @kolu/* packages (surface, surface-remote, surface-map, surface-app,
# solid-pwa-install, surface-daemon, surface-daemon-supervisor) are sourced
# hermetically from the npins-pinned kolu tree: the overlay extracts each as a
# nix-store path (nix/overlay.nix), nix/env.nix exports it as
# $DRISHTI_KOLU_SURFACE{,_REMOTE,_MAP,_APP,_DAEMON,_DAEMON_SUPERVISOR} /
# $DRISHTI_KOLU_SOLID_PWA_INSTALL, and this recipe copies it into
# node_modules. The raw .ts is consumed directly (no build step).
install:
    {{ nix_shell }} bun install
    {{ nix_shell }} sh -c 'sh scripts/hydrate-kolu-packages.sh \
      "$DRISHTI_KOLU_SURFACE" @kolu/surface \
      "$DRISHTI_KOLU_SURFACE_REMOTE" @kolu/surface-remote \
      "$DRISHTI_KOLU_SURFACE_MAP" @kolu/surface-map \
      "$DRISHTI_KOLU_SHELL_QUOTE" @kolu/shell-quote \
      "$DRISHTI_KOLU_LOG" @kolu/log \
      "$DRISHTI_KOLU_BYTE_UNITS" @kolu/byte-units \
      "$DRISHTI_KOLU_SURFACE_APP" @kolu/surface-app \
      "$DRISHTI_KOLU_SOLID_PWA_INSTALL" @kolu/solid-pwa-install \
      "$DRISHTI_KOLU_SURFACE_DAEMON" @kolu/surface-daemon \
      "$DRISHTI_KOLU_SURFACE_DAEMON_SUPERVISOR" @kolu/surface-daemon-supervisor \
      "$DRISHTI_OSFACTS_CLIENT" osfacts-client'

# Boot the parent server. Defaults to localhost; pass any number of
# user@host targets after it. Exports SURFACE_AGENT_FLAKE_REF — the assembled
# agent source every host's agent is resolved from — and DRISHTI_AGENT_BUILD_ID,
# the identity the supervisor expects. Nothing else about delivery is spelled
# here: the source bakes its own `binary-cache.json` (caches + closure index)
# beside `commit-hash`, and @kolu/surface-remote reads both.
dev host='localhost' *args: install
    #!/usr/bin/env bash
    set -euo pipefail
    # `nix build`, not `nix eval`: the source must EXIST as a directory for the
    # framework to read its sidecar from.
    agent_source=$(nix build --no-link --print-out-paths "{{ justfile_directory() }}#agent-flake-source")
    build_id=$(nix eval --raw "{{ justfile_directory() }}#agentBuildId")
    echo "» agent source: $agent_source"
    echo "» agent identity: $build_id"
    SURFACE_AGENT_FLAKE_REF="$agent_source" \
    DRISHTI_AGENT_BUILD_ID="$build_id" \
    {{ nix_shell }} bun --cwd packages/app dev {{ host }} {{ args }}

# TypeScript type checking (every workspace member: common, agent, app)
typecheck: install
    {{ nix_shell }} bun run typecheck

# Run the test suite. `--conditions=browser` resolves solid-js to its client
# build (dist/solid.js): under bun's default `node` condition solid resolves to
# its inert SSR build, where createEffect/createStore reactivity silently
# no-ops — so a reactive client test (e.g. processesStream.test.ts) would pass
# vacuously. The flag is safe for the node-side agent/server tests; their
# resolution is unchanged.
#
# Heavy pool/window e2e legs key on KOLU_DAEMON_TESTS (kolu daemon-test-gate);
# this default leaves them OFF so GHA/shared runners skip them. Use
# `just test-daemon` (or `ci::test-daemon` on odu linux) for the full suite.
# App-scoped Solid/happy-dom preload (NOT root bunfig — agent BUILD_ID).
test_preload := "--preload ./packages/app/src/client/test-setup.ts"

test *args: install
    {{ nix_shell }} bun test --conditions=browser {{ test_preload }} {{ args }}

# Full suite including daemon-gated e2e (KOLU_DAEMON_TESTS=1). Same env kolu's
# `describeDaemon` / odu daemon lane uses — no new knob. Forks real agents and
# may realise agent .drvs; CI/odu linux only (not GHA default `just test`).
test-daemon *args: install
    KOLU_DAEMON_TESTS=1 {{ nix_shell }} bun test --conditions=browser {{ test_preload }} {{ args }}

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

# Regenerate the agent-scoped lock + agent.bun.nix (positive projection).
# Run after changing packages/agent or packages/common dependencies.
# Does NOT touch the root bun.lock / bun.nix (app-only churn stays there).
regenerate-agent-deps:
    {{ nix_shell }} sh scripts/regenerate-agent-deps.sh

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
