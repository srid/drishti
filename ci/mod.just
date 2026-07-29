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
# `test-daemon` is linux-only (see recipe tags below): GHA macos runs bare
# `just test` with KOLU_DAEMON_TESTS unset so heavy pool e2e is a named skip.
[linux]
[macos]
[parallel]
[metadata("ci")]
default: nix typecheck fmt-check bun-nix-fresh flake-check home-manager drv-stability agent-boots test-daemon

# Single per-platform `bun install`. Funnel every bun consumer through this
# node so concurrent `bun install` runs against the same workspace don't race.
# The hydrate call is wrapped in `sh -c '...'` so `$DRISHTI_KOLU_*` is
# expanded inside the nix-develop shell that exports it, not by just's outer
# shell (which runs under `set -u`).
install:
    {{ nix_shell }} bun install
    {{ nix_shell }} sh -c 'sh scripts/hydrate-kolu-packages.sh \
      "$DRISHTI_KOLU_SURFACE" @kolu/surface \
      "$DRISHTI_KOLU_SURFACE_REMOTE" @kolu/surface-remote \
      "$DRISHTI_KOLU_SURFACE_MAP" @kolu/surface-map \
      "$DRISHTI_KOLU_SHELL_QUOTE" @kolu/shell-quote \
      "$DRISHTI_KOLU_LOG" @kolu/log \
      "$DRISHTI_KOLU_SURFACE_APP" @kolu/surface-app \
      "$DRISHTI_KOLU_SOLID_PWA_INSTALL" @kolu/solid-pwa-install \
      "$DRISHTI_KOLU_SURFACE_DAEMON" @kolu/surface-daemon \
      "$DRISHTI_KOLU_SURFACE_DAEMON_SUPERVISOR" @kolu/surface-daemon-supervisor \
      "$DRISHTI_OSFACTS_CLIENT" osfacts-client'

# Pre-populate the nix store with crates.io tarballs that nixpkgs' fetchurl
# can't download (crates.io returns 403 for curl/* User-Agent). Idempotent;
# once crates are cached this is a few nix-store metadata lookups. Drop this
# recipe once upstream fetchurl / bun2nix sidesteps the UA filter.
_prefetch-crates:
    {{ nix_shell }} sh scripts/ci-prefetch-crates.sh

# Build all flake outputs via devour-flake.
nix: _prefetch-crates
    nix build github:srid/devour-flake -L --no-link --print-out-paths --override-input flake .

# Build the home-manager example flake (nix/home/example) against THIS repo:
# the Linux nixosTest boots a VM and curls the systemd user service, and the
# Darwin check eval-builds the launchd plist. `flake/drishti` is overridden to
# the repo root so the example consumes the local module, not the published one.
home-manager: nix
    nix build github:srid/devour-flake -L --no-link --print-out-paths --override-input flake ./nix/home/example --override-input flake/drishti .

# TypeScript type checking (every workspace member: common, agent, app)
typecheck: install
    {{ nix_shell }} bun run typecheck

# Acceptance guard for issue #38: a client/server-only edit must NOT change the
# agent's .drv hash — otherwise every remote re-copies + rebuilds the agent on
# Fleet BUILD_ID stability (W2.5 / U5.1). Identity is the INNER wrapper hash.
# Probes (throwaway worktrees; host tree untouched):
#   (a) client .ts edit → BUILD_ID unchanged
#   (b) REAL app-only devDependency + lock + bun.nix regen → all ids unchanged
#   (c) agent-touching source edit → BUILD_ID rotates
# Pinned via full agentBuildIdsJson map comparison for (b); x86_64 for (a)/(c).
drv-stability:
    #!/usr/bin/env bash
    set -euo pipefail
    extract_id() {
      sed -n 's/.*"x86_64-linux"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
    }
    base_map=$(nix eval --raw --no-eval-cache '.#agentBuildIdsJson')
    base=$(printf '%s' "$base_map" | extract_id)
    if [ -z "$base" ]; then
      echo "drv-stability: FAIL — empty x86_64-linux BUILD_ID from agentBuildIdsJson"
      exit 1
    fi
    echo "drv-stability: base BUILD_ID map=$base_map"

    run_probe() {
      local name="$1" expect_change="$2" # 0=unchanged, 1=rotated (x86 only)
      local mutator="$3"
      local compare_full_map="${4:-0}"
      local tmp wt after after_map
      tmp=$(mktemp -d)
      wt="$tmp/wt"
      git worktree add -q --detach "$wt" HEAD
      WT="$wt" bash -c "$mutator"
      git -C "$wt" -c user.email=ci@drishti -c user.name=ci add -A
      # Allow empty commit only if mutator made no git-visible change (should not).
      git -C "$wt" -c user.email=ci@drishti -c user.name=ci \
        commit -qm "drv-stability probe: $name" || true
      after_map=$(nix eval --raw --no-eval-cache "$wt#agentBuildIdsJson")
      after=$(printf '%s' "$after_map" | extract_id)
      git worktree remove --force "$wt" 2>/dev/null || true
      rm -rf "$tmp"
      if [ "$expect_change" = "0" ]; then
        if [ "$compare_full_map" = "1" ]; then
          if [ "$base_map" = "$after_map" ]; then
            echo "drv-stability: PASS ($name) — all three BUILD_IDs byte-identical"
            echo "  map: $base_map"
          else
            echo "drv-stability: FAIL ($name) — BUILD_ID map rotated (must stay put)"
            echo "  before: $base_map"
            echo "  after:  $after_map"
            exit 1
          fi
        elif [ "$base" = "$after" ]; then
          echo "drv-stability: PASS ($name) — BUILD_ID unchanged ($base)"
        else
          echo "drv-stability: FAIL ($name) — BUILD_ID rotated (must stay put)"
          echo "  before: $base"
          echo "  after:  $after"
          exit 1
        fi
      else
        if [ "$base" != "$after" ]; then
          echo "drv-stability: PASS ($name) — BUILD_ID rotated as expected"
          echo "  before: $base"
          echo "  after:  $after"
        else
          echo "drv-stability: FAIL ($name) — BUILD_ID stayed put (must rotate on agent touch)"
          echo "  id: $base"
          exit 1
        fi
      fi
    }

    # (a) client-only source edit
    run_probe "client-ts" 0 \
      'printf "\n// drv-stability probe — client edit must not churn agent BUILD_ID\n" >> "$WT/packages/app/src/client/theme.ts"'

    # (b) REAL app-only devDependency: add a package, regenerate root lock + bun.nix.
    # Agent projection (agent.lock / agent.bun.nix) is untouched → ids frozen.
    run_probe "app-only-devDep" 0 \
      'set -euo pipefail
       cd "$WT"
       # Add a real app-only devDependency (not in agent.lock projection).
       bun add -d left-pad@1.3.0 --cwd packages/app
       nix run .#bun2nix -- -l bun.lock -o bun.nix
       nixpkgs-fmt bun.nix >/dev/null
       # Prove agent projection was not rewritten.
       git diff --exit-code packages/agent/agent.lock packages/agent/agent.bun.nix
      ' 1

    # (c) agent-touching edit must rotate
    run_probe "agent-touch" 1 \
      'printf "\n// drv-stability probe — agent touch must rotate BUILD_ID\n" >> "$WT/packages/agent/src/main.ts"'

# Flake schema check — packages.* must be derivations (U4.2). Catches raw
# strings under packages.<system> that GHA build alone misses.
flake-check:
    {{ nix_shell }} nix flake check --no-build --show-trace

# Boot the BUILT agent to prove its runtime module graph resolves — the guard
# this pipeline lacked. `typecheck` resolves `@kolu/*` from the dev node_modules
# (which has everything) and `nix build` only COPIES the agent's tree, so a
# runtime-only missing dependency stays invisible until the agent actually runs:
# the agent-shared `drishti-common` (common/surface.ts) must import NOTHING from
# `@kolu/surface-nix-host`, because the agent's scoped build deliberately hydrates
# only `@kolu/surface` (nix/packages/drishti-agent) — a stray import crashes the
# remote agent with "Cannot find module" on every connect. A bare invocation
# loads `common/surface.ts` at import (before printing usage), so a broken module
# graph fails HERE with that error instead of the banner.
agent-boots:
    #!/usr/bin/env bash
    set -euo pipefail
    nix build .#drishti-agent
    # UW3: bare invocation is the durable daemon (hangs waiting for
    # connections). --help loads the full module graph and prints usage,
    # proving runtime resolution without starting the daemon.
    out=$(./result/bin/drishti-agent --help 2>&1 || true)
    if printf '%s' "$out" | grep -q "drishti-agent —"; then
      echo "agent-boots: PASS — the built agent's module graph resolves at runtime"
    else
      echo "agent-boots: FAIL — the built agent did not boot (runtime module error?):"
      printf '%s\n' "$out"
      exit 1
    fi
    # Joint invariant (W2.5 outer stamp): non-empty BUILD_ID ⇒ non-empty COMMIT_HASH.
    # MUTATION: drop --set DRISHTI_AGENT_COMMIT_HASH from the outer agent wrapper ⇒ red.
    # makeWrapper writes env into the launcher script — probe it directly.
    wrap=./result/bin/drishti-agent
    if ! grep -q 'DRISHTI_AGENT_BUILD_ID' "$wrap"; then
      echo "agent-boots: FAIL — outer wrapper missing DRISHTI_AGENT_BUILD_ID"
      exit 1
    fi
    if ! grep -q 'DRISHTI_AGENT_COMMIT_HASH' "$wrap"; then
      echo "agent-boots: FAIL — outer wrapper missing DRISHTI_AGENT_COMMIT_HASH (joint invariant)"
      exit 1
    fi
    build_id=$(grep -oE 'DRISHTI_AGENT_BUILD_ID=[^[:space:]"]+' "$wrap" | head -1 | cut -d= -f2- | tr -d \"\')
    commit=$(grep -oE 'DRISHTI_AGENT_COMMIT_HASH=[^[:space:]"]+' "$wrap" | head -1 | cut -d= -f2- | tr -d \"\')
    if [ -n "$build_id" ] && [ -z "$commit" ]; then
      echo "agent-boots: FAIL — joint invariant: non-empty BUILD_ID requires non-empty COMMIT_HASH"
      echo "  BUILD_ID=$build_id COMMIT_HASH=<empty>"
      exit 1
    fi
    echo "agent-boots: PASS — joint identity stamp present (BUILD_ID + COMMIT_HASH)"

# Check formatting without modifying (nixpkgs-fmt). Accepts a directory
# argument and recurses, so `.` covers every *.nix at any depth.
fmt-check:
    {{ nix_shell }} nixpkgs-fmt --check .

# Full bun suite with kolu's daemon spawn-guard env ON (KOLU_DAEMON_TESTS=1).
# Declared on both platforms so `default` can depend on it (just rejects an
# unknown dep on macos if the recipe is [linux]-only). Body is a no-op skip
# off Linux; odu linux actually runs the suite. GHA uses bare `just test`
# (gate OFF → named skip of the heavy pool e2e).
[linux]
[macos]
test-daemon: install
    # App-scoped Solid preload (must not live on root bunfig — agent BUILD_ID).
    {{ nix_shell }} sh -c '\
      if [ "$(uname -s)" = Linux ]; then \
        KOLU_DAEMON_TESTS=1 bun test --conditions=browser \
          --preload ./packages/app/src/client/test-setup.ts; \
      else \
        echo "test-daemon: skip on $(uname -s) — pool e2e is odu-linux / KOLU_DAEMON_TESTS"; \
      fi'

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
