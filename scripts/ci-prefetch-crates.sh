#!/usr/bin/env bash
# Pre-populate the nix store with crates.io tarballs that nixpkgs' fetchurl
# can't download. As of 2026-05, crates.io's anti-bot layer returns HTTP 403
# for requests carrying a `curl/*` User-Agent (the default for nixpkgs
# fetchurl), which blocks every `crate-*.tar.gz` FOD reachable from this
# project's bun2nix build closure.
#
# Workaround: fetch each missing crate via curl with a non-curl UA, then
# inject the tarball into the local nix store with `nix-store --add-fixed`.
# The result is a content-addressed store path that matches the FOD's
# outputHash, so subsequent `nix build` calls find the artifact already
# realised and skip the network entirely.
#
# Idempotent: crates whose output is already valid in the store are skipped.
# When upstream nixpkgs / bun2nix sidesteps the UA filter (e.g. by hitting
# `static.crates.io` directly), drop the `_prefetch-crates` recipe from
# `ci/mod.just`'s `nix:` deps and delete this script.

set -euo pipefail

UA='Mozilla/5.0'
flake_root=${1:-.}

bun2nix_drv=$(nix eval --raw "${flake_root}#bun2nix.drvPath")
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

nix-store --query --requisites "$bun2nix_drv" \
  | grep 'crate-.*\.tar\.gz\.drv$' \
  | while read -r cdrv; do
      out=$(nix-store --query --outputs "$cdrv")
      if nix-store --check-validity "$out" 2>/dev/null; then
        continue
      fi

      # Parse name + version from store basename: <hash>-crate-<name>-<ver>.tar.gz
      bn=$(basename "$cdrv" .tar.gz.drv)
      bn=${bn#*-crate-}
      ver=${bn##*-}
      name=${bn%-"$ver"}

      url="https://crates.io/api/v1/crates/$name/$ver/download"
      tmp="$tmpdir/crate-$name-$ver.tar.gz"
      curl -fsSL -A "$UA" -o "$tmp" "$url"
      nix-store --add-fixed sha256 "$tmp" >/dev/null
      echo "prefetched: $name $ver"
    done
