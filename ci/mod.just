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
default: nix typecheck fmt-check bun-nix-fresh flake-check home-manager drv-stability agent-flake-nix agent-boots test-daemon

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
      "$DRISHTI_KOLU_BYTE_UNITS" @kolu/byte-units \
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
# agent's BUILD_ID — otherwise every remote re-copies + rebuilds the agent on
# Fleet BUILD_ID stability (UW3 / U5.1 / U6.1). The identity hashes the agent's
# SOURCE closure (@kolu/surface-daemon's mkDaemonIdentity), so it is one scalar
# that answers for every platform, not a per-system map. Probes (throwaway
# worktrees; host tree untouched):
#   (a) client .ts edit
#   (b) REAL app-only devDependency + lock + bun.nix regen
#   (c) root package.json only (manifest noise — not an agent input)
#   (d) app-only script edit (scripts/ not in agent fileset except hydrate)
#   (e) agent-touching source edit → BUILD_ID rotates
drv-stability:
    #!/usr/bin/env bash
    set -euo pipefail
    # Shebang recipes on odu may lack this recipe's tools on PATH. Re-enter the
    # flake devShell once (outer tree only — never nest nix develop in a
    # worktree). Probe EVERY tool the recipe needs, not just bun: since odu
    # itself runs on Bun (juspay/odu#72) the lane runner carries `bun`, so a
    # bun-only probe skips the shell and probe (b) dies at `nixpkgs-fmt`
    # (dev-shell-only) with exit 127.
    if [ -z "${IN_NIX_SHELL:-}" ] && { ! command -v bun >/dev/null 2>&1 || ! command -v nixpkgs-fmt >/dev/null 2>&1; }; then
      exec nix develop --accept-flake-config -c bash "$0" "$@"
    fi
    base=$(nix eval --raw --no-eval-cache '.#agentBuildId')
    if [ -z "$base" ]; then
      echo "drv-stability: FAIL — empty BUILD_ID from agentBuildId"
      exit 1
    fi
    echo "drv-stability: base BUILD_ID=$base"

    run_probe() {
      local name="$1" expect_change="$2" # 0=unchanged, 1=rotated
      local mutator="$3"
      local tmp wt after
      tmp=$(mktemp -d)
      wt="$tmp/wt"
      git worktree add -q --detach "$wt" HEAD
      WT="$wt" bash -c "$mutator"
      git -C "$wt" -c user.email=ci@drishti -c user.name=ci add -A
      git -C "$wt" -c user.email=ci@drishti -c user.name=ci \
        commit -qm "drv-stability probe: $name" || true
      after=$(nix eval --raw --no-eval-cache "$wt#agentBuildId")
      git worktree remove --force "$wt" 2>/dev/null || true
      rm -rf "$tmp"
      if [ "$expect_change" = "0" ]; then
        if [ "$base" = "$after" ]; then
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

    # (b) REAL app-only devDependency + root lock/bun.nix regen (bun from outer shell)
    run_probe "app-only-devDep" 0 \
      'set -euo pipefail
       cd "$WT"
       bun add -d left-pad@1.3.0 --cwd packages/app
       nix run .#bun2nix -- -l bun.lock -o bun.nix
       nixpkgs-fmt bun.nix >/dev/null
       git diff --exit-code packages/agent/agent.lock packages/agent/agent.bun.nix packages/agent/agent.package.json
      '

    # (c) root package.json only (U6.1 — not an agent input)
    run_probe "root-manifest-only" 0 \
      'printf "\n  , \"//drv-stability\": \"root package.json only\"\n" >> "$WT/package.json"'

    # (d) app-only script (U6.1 — scripts/ except hydrate is not an agent input)
    run_probe "app-only-script" 0 \
      'printf "\n// drv-stability probe — app-only script must not churn agent BUILD_ID\n" >> "$WT/scripts/gen-pwa-icons.ts"'

    # (e) agent-touching edit must rotate
    run_probe "agent-touch" 1 \
      'printf "\n// drv-stability probe — agent touch must rotate BUILD_ID\n" >> "$WT/packages/agent/src/main.ts"'

# The agent SOURCE must EVALUATE for the systems a remote host can be — the
# eval-time gate mkProvenAgentSource's prove cannot give drishti (the assembled
# tree's own default.nix needs bun2nix, which reaches a tree only as a flake
# input; see default.nix). Every exposed attr's `drvPath` is forced from the
# EXACT source the monitor bakes as SURFACE_AGENT_FLAKE_REF, including
# aarch64-linux, which no CI runner builds on. Pure eval, no build.
agent-flake-nix:
    #!/usr/bin/env bash
    set -euo pipefail
    src=$(nix build --no-link --print-out-paths --accept-flake-config '.#agent-flake-source')
    echo "agent-flake-nix: source $src"
    for system in x86_64-linux aarch64-linux aarch64-darwin; do
      drv=$(nix eval --raw --accept-flake-config "$src#packages.$system.drishti-agent.drvPath")
      case "$drv" in
        *.drv) echo "agent-flake-nix: PASS ($system) $drv" ;;
        *)
          echo "agent-flake-nix: FAIL ($system) — not a derivation: $drv"
          exit 1
          ;;
      esac
    done

# Flake schema check — packages.* must be derivations (U4.2). Catches raw
# strings under packages.<system> that GHA build alone misses. After `nix`
# so a re-pin's new kolu package paths are realised before --no-build walks them.
flake-check: nix
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
