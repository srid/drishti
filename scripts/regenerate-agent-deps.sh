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

cat >"$tmp/package.json" <<'EOF'
{
  "name": "drishti-agent-workspace",
  "private": true,
  "type": "module",
  "workspaces": ["packages/agent", "packages/common"],
  "overrides": {
    "@babel/helper-module-imports": "^7.29.7",
    "@effect/platform-node": "4.0.0-beta.103",
    "effect": "4.0.0-beta.106"
  }
}
EOF
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
