# The AGENT flake — the whole of what a remote host resolves drishti's agent
# from. mkAgentSourceTree copies this file to `flake.nix` at the root of the
# assembled source, so a binder's `provisionAgent` runs
#   nix eval <baked-source>#packages.<host-system>.drishti-agent.drvPath
# and the host realises exactly that closure.
#
# It is deliberately minimal — no app, website, checks, dev shells or the
# monitor — because this flake's source is baked onto the monitor wrapper as
# SURFACE_AGENT_FLAKE_REF and therefore rides the monitor's own closure.
#
# `bun2nix` is this flake's ONLY input, and it is required: drishti's agent is a
# bun workspace (packages/agent + packages/common), so its derivation needs
# bun2nix's standalone helpers (`lib.mkBun2nix`), which exist only as flake
# outputs — there is no nixpkgs `fetchBunDeps`/`buildBunPackage` to import
# instead. The assembled tree carries the root flake's `flake.lock`, so this
# input is locked here and nothing re-locks at dial time.
{
  inputs.bun2nix.url = "github:juspay/bun2nix/rawflake";

  # The caches the agent's closure is fetched from. Load-bearing, not
  # decoration: mkAgentSourceTree derives the source's `binary-cache.json`
  # sidecar from THIS block, and @kolu/surface-remote refuses to provision an
  # agent source without one — so provisioning prefetches from exactly the
  # caches `nix build --accept-flake-config <source>#…` would, and a manual
  # build cannot drift from the provisioning path. Same strings as the root
  # flake's nixConfig: CI pushes the agent's content-addressed builds to this
  # cache (`.github/actions/publish-closure`), and the host pulls them from it.
  nixConfig = {
    extra-substituters = "https://cache.nixos.asia/oss";
    extra-trusted-public-keys = "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=";
  };

  outputs = { self, bun2nix, ... }:
    let
      # Kept in step with the root flake's own list by `just ci::agent-flake-nix`,
      # which evaluates every system's `drishti-agent` from the assembled source
      # on every platform CI has — including the ones no runner builds on.
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];

      # The navigable rev the binder baked beside this flake, NOT `self.rev`: an
      # assembled source tree has no git metadata, and a "dev" identity here
      # would key the closure index wrong.
      commitHash = builtins.readFile ./commit-hash;

      perSystem = system:
        let
          pkgs = import ./nix/nixpkgs.nix { inherit system; };
          b2n = bun2nix.lib.mkBun2nix { inherit pkgs; };
        in
        {
          drishti-agent = (import ./default.nix {
            inherit pkgs commitHash b2n;
          }).drishti-agent;
        };
    in
    {
      packages = builtins.listToAttrs (map
        (system: {
          name = system;
          value = perSystem system;
        })
        systems);
    };
}
