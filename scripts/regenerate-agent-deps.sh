#!/usr/bin/env bash
# Rebuild packages/agent/agent.lock + agent.bun.nix from agent+common only.
# Root workspace lock/bun.nix are deliberately NOT inputs — app-only deps
# never enter the agent projection (U5.1 positive dependency set).
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/packages"
cp -a packages/agent "$tmp/packages/"
cp -a packages/common "$tmp/packages/"
rm -f "$tmp/packages/agent/agent.lock" \
  "$tmp/packages/agent/agent.bunfig.toml" \
  "$tmp/packages/agent/agent.bun.nix"

# The agent workspace's manifest is `packages/agent/agent.package.json` — the SAME file
# `nix/packages/drishti-agent` copies to `package.json` at build time. Copy it; never
# re-spell it. It used to be duplicated as a heredoc here, and the two copies drifted:
# this one carried `effect: 4.0.0-beta.106` while the committed one still said `.103`, so
# the regenerated lock claimed .106 and the BUILT agent installed .103 — which showed up
# only as a boot crash (`Schema.TaggedError is not a function`), because nothing
# typechecks the agent's runtime closure. One manifest, one place to bump.
cp packages/agent/agent.package.json "$tmp/package.json"
cat >"$tmp/bunfig.toml" <<'EOF'
[install]
linker = "hoisted"
EOF

(
  cd "$tmp"
  bun install
  nix run "$root#bun2nix" -- -l bun.lock -o agent.bun.nix
  # Paths in agent.bun.nix are relative to packages/agent/ once installed there.
  # Paths are relative to packages/agent/ once installed there.
  sed -i \
    -e 's|copyPathToStore \./packages/agent|copyPathToStore ./.|g' \
    -e 's|copyPathToStore \./packages/common|copyPathToStore ../common|g' \
    agent.bun.nix
  nixpkgs-fmt agent.bun.nix >/dev/null
)

cp "$tmp/bun.lock" packages/agent/agent.lock
cp "$tmp/agent.bun.nix" packages/agent/agent.bun.nix
echo "regenerate-agent-deps: wrote packages/agent/agent.lock + agent.bun.nix"
