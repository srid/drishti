# The agent's behavioral closure — WHAT a restart of the remote agent would
# load. ONE policy, two consumers, so a file added for one cannot silently miss
# the other:
#
#  1. nix/packages/drishti-agent — the tree the agent is built from.
#  2. default.nix's `mkDaemonIdentity` — the currency key (`DRISHTI_AGENT_BUILD_ID`)
#     a supervisor compares against the running agent's own reported identity.
#     Its meaning is exactly this closure: it flips iff a restart would load
#     different code (see @kolu/surface-daemon's daemon-identity.nix).
#
# Deliberately NOT here:
#   * the app/client — an app-only edit must not churn the agent's identity
#     (`just ci::drv-stability` pins that; issue #38).
#   * the runtime engine (bun, the nixpkgs pin) — an engine-only deploy is
#     adopted, not converged. kolu's daemon-identity.nix documents that trade
#     and why over-firing is the worse failure.
#   * the `@kolu/*` packages the agent hydrates — those arrive through the kolu
#     npins pin, which rides `pinnedSources` as a content-addressed store path.
{ lib }:
let
  root = ../.;
in
rec {
  inherit root;
  fileset = lib.fileset.unions [
    (root + "/packages/agent")
    (root + "/packages/common")
    # Single hydrate script — not the whole scripts/ directory (U6.1).
    (root + "/scripts/hydrate-kolu-packages.sh")
    # tsconfig.base is extended by packages/*/tsconfig.json.
    (root + "/tsconfig.base.json")
  ];
}
