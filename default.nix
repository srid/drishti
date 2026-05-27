# Root composer for drishti Nix derivations.
#
# The dev shell consumes `kolu-surface` + `kolu-surface-nix-host` (via
# `nix/env.nix`); the wrappers below feed `nix run` / `nix build`.
#
# Three user-facing derivations, all backed by the same `drishtiBuilt`:
#
#   drishti-agent  — the remote-side binary. `nix copy --derivation` ships
#                     this .drv to the SSH target host, which realises it
#                     locally. Wraps bun → packages/app/src/agent/main.ts.
#
#   drishti-client — the static client bundle ($out is the dist dir).
#                     The monitor wrapper bakes DRISHTI_DIST_DIR to this.
#
#   drishti        — the monitor (default attr). Wraps bun →
#                     packages/app/src/server/main.ts; bakes
#                     DRISHTI_AGENT_DRV (current-system agent .drv) and
#                     DRISHTI_DIST_DIR (drishti-client). meta.mainProgram
#                     is "drishti" so `nix run` resolves cleanly.
#
# `b2n` carries the bun2nix helpers; passed in from flake.nix via
# `lib.mkBun2nix { inherit pkgs; }` (juspay/bun2nix rawflake standalone API).
{ pkgs ? null
, b2n ? null
}:
let
  resolvedPkgs =
    if pkgs != null
    then pkgs
    else import ./nix/nixpkgs.nix { };
  # b2n is required for the `drishtiBuilt` derivation. When `default.nix`
  # is imported without it (e.g. `nix-build -A kolu-surface`), only the
  # overlay attrs are realizable. The build derivation throws on access
  # if needed without bun2nix wired up.
  drishtiBuilt =
    if b2n != null
    then resolvedPkgs.callPackage ./nix/packages/drishti { bun2nix = b2n; }
    else throw "drishti build derivation needs `b2n` (lib.mkBun2nix output) — invoke via flake.nix";

  drishti-agent = resolvedPkgs.runCommand "drishti-agent"
    {
      nativeBuildInputs = [ resolvedPkgs.makeWrapper ];
      meta.mainProgram = "drishti-agent";
    } ''
    mkdir -p $out/bin
    makeWrapper ${resolvedPkgs.bun}/bin/bun $out/bin/drishti-agent \
      --add-flags "${drishtiBuilt}/lib/drishti/packages/app/src/agent/main.ts"
  '';

  drishti-client = resolvedPkgs.runCommand "drishti-client"
    {
      meta.description = "drishti browser bundle (static assets)";
    } ''
    cp -r ${drishtiBuilt}/lib/drishti/packages/app/dist $out
  '';

  drishti = resolvedPkgs.runCommand "drishti"
    {
      nativeBuildInputs = [ resolvedPkgs.makeWrapper ];
      meta.mainProgram = "drishti";
    } ''
    mkdir -p $out/bin
    makeWrapper ${resolvedPkgs.bun}/bin/bun $out/bin/drishti \
      --add-flags "${drishtiBuilt}/lib/drishti/packages/app/src/server/main.ts" \
      --set DRISHTI_DIST_DIR "${drishti-client}" \
      `# DRISHTI_AGENT_DRV is derived from the drishti-agent let-binding above.` \
      `# drvPath is a STRING interpolation, not a Nix dependency edge — if the` \
      `# attribute is renamed or split, this wrapper compiles fine but points at` \
      `# a stale .drv and HostSession crashes at \`nix copy --derivation\` time.` \
      --set-default DRISHTI_AGENT_DRV "${drishti-agent.drvPath}" \
      --prefix PATH : ${resolvedPkgs.lib.makeBinPath [ resolvedPkgs.openssh resolvedPkgs.nix ]}
  '';
in
{
  inherit drishti drishti-agent drishti-client drishtiBuilt;
  inherit (resolvedPkgs) kolu-surface kolu-surface-nix-host;
}
