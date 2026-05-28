# Factory: narrow the npins-pinned kolu source to a single workspace
# package so the dev shell can symlink only what drishti actually
# consumes. No vendoring — kolu lives upstream.
#
# Usage (from nix/overlay.nix):
#
#   let mkKoluPackage = import ./packages/kolu-package.nix { pkgs = final; };
#   in { kolu-surface = mkKoluPackage "surface"; … }
{ pkgs }:
name: pkgs.runCommand "kolu-${name}"
{
  meta = {
    description = "@kolu/${name} source extracted from juspay/kolu";
    homepage = "https://github.com/juspay/kolu";
  };
}
  ''
    cp -r ${(import ../../npins).kolu}/packages/${name} $out
  ''
