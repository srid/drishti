# drishti CI pipeline — consumed by odu (github.com/juspay/odu).
#
# The runner discovers the recipe tagged [metadata("ci")] (exactly one across
# this justfile and its submodules), expands its reachable dependency subgraph,
# and fans every (recipe × platform) pair out as a pipeline node odu holds as
# live state on `.ci/odu.sock` (attach with `nix run github:juspay/odu -- attach`).
# odu ships its own generic lane runner, so this repo re-exports nothing. Lane
# hosts come from hosts.json ($ODU_HOSTS → ~/.config/odu/hosts.json →
# ~/.config/justci/hosts.json); a `localhost` lane runs against the HEAD
# snapshot, remote lanes `git fetch` the pushed SHA into a per-SHA workspace.

set working-directory := '..'

# Re-enter nix devShell when the runner ssh's into a remote that doesn't have
# the project's dev tools on PATH. Skipped when already inside the shell.
nix_shell := if env('IN_NIX_SHELL', '') != '' { '' } else { 'nix develop --accept-flake-config -c' }

# Pipeline root: every recipe listed here becomes a (recipe × platform) node.
[linux]
[macos]
[parallel]
[metadata("ci")]
default: nix typecheck unit fmt-check home-manager drv-stability

# Single per-platform `pnpm install`. Funnel every consumer through this
# node so concurrent installs against the same workspace don't race.
# The hydrate call is wrapped in `sh -c '...'` so `$DRISHTI_KOLU_*` is
# expanded inside the nix-develop shell that exports it, not by just's outer
# shell (which runs under `set -u`).
install:
    {{ nix_shell }} pnpm install --frozen-lockfile
    {{ nix_shell }} sh -c 'sh scripts/hydrate-kolu-packages.sh \
      "$DRISHTI_KOLU_SURFACE" @kolu/surface \
      "$DRISHTI_KOLU_SURFACE_NIX_HOST" @kolu/surface-nix-host \
      "$DRISHTI_KOLU_SURFACE_APP" @kolu/surface-app \
      "$DRISHTI_KOLU_SOLID_PWA_INSTALL" @kolu/solid-pwa-install'

# Build all flake outputs via devour-flake.
nix:
    nix build github:srid/devour-flake -L --no-link --print-out-paths --override-input flake .

# Build the home-manager example flake (nix/home/example) against THIS repo:
# the Linux nixosTest boots a VM and curls the systemd user service, and the
# Darwin check eval-builds the launchd plist. `flake/drishti` is overridden to
# the repo root so the example consumes the local module, not the published one.
home-manager: nix
    nix build github:srid/devour-flake -L --no-link --print-out-paths --override-input flake ./nix/home/example --override-input flake/drishti .

# TypeScript type checking (every workspace member: common, agent, app)
typecheck: install
    {{ nix_shell }} pnpm typecheck

# Unit tests (vitest, every workspace member). build.test.ts runs a real Vite
# client build, so this needs the install node's node_modules + hydrated @kolu/*.
unit: install
    {{ nix_shell }} pnpm test:unit

# Acceptance guard for issue #38: a client/server-only edit must NOT change the
# agent's .drv hash — otherwise every remote re-copies + rebuilds the agent on
# the next reconnect. We snapshot drishti-agent.drvPath, replay a client-only
# edit in a throwaway git worktree (so this host's tree is never touched), and
# assert the drvPath is byte-identical. Pinned to x86_64-linux's drvPath: pure
# cross-arch eval makes the evaluating platform irrelevant, so one check on any
# host covers the whole agentDrvBySystem map. `--no-eval-cache` so a warm eval
# cache can't mask a regression.
drv-stability:
    #!/usr/bin/env bash
    set -euo pipefail
    attr='packages.x86_64-linux.drishti-agent.drvPath'
    base=$(nix eval --raw --no-eval-cache ".#$attr")
    tmp=$(mktemp -d)
    wt="$tmp/wt"
    trap 'git worktree remove --force "$wt" 2>/dev/null || true; rm -rf "$tmp"' EXIT
    git worktree add -q --detach "$wt" HEAD
    printf '\n// drv-stability probe — client edit must not churn the agent\n' \
      >> "$wt/packages/app/src/client/theme.ts"
    git -C "$wt" -c user.email=ci@drishti -c user.name=ci commit -qam 'drv-stability probe'
    after=$(nix eval --raw --no-eval-cache "$wt#$attr")
    if [ "$base" = "$after" ]; then
      echo "drv-stability: PASS — agent .drv unchanged across a client edit ($base)"
    else
      echo "drv-stability: FAIL — a client edit churned the agent .drv"
      echo "  before: $base"
      echo "  after:  $after"
      exit 1
    fi

# Check formatting without modifying (nixpkgs-fmt). Accepts a directory
# argument and recurses, so `.` covers every *.nix at any depth.
fmt-check:
    {{ nix_shell }} nixpkgs-fmt --check .
