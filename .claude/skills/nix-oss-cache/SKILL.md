---
name: nix-oss-cache
description: Use this when setting up a GitHub repo to push its Nix builds to Juspay's shared OSS Attic cache (cache.nixos.asia/oss) — adds the substituter to flake.nix, a nix-cache.yml GitHub Actions workflow, and prompts for the ATTIC_TOKEN secret.
---

# Push to Juspay's OSS Nix cache

Wire a GitHub repo into the shared Attic cache at [`cache.nixos.asia/oss`](https://cache.nixos.asia). CI builds the flake's default package on every push to the default branch and pushes the resulting closure, warming both CI and local `nix build`s for everyone. Reference: [juspay/kolu#1731](https://github.com/juspay/kolu/pull/1731), [#1733](https://github.com/juspay/kolu/pull/1733).

Three pieces are needed: the cache as a **substituter** (so the repo _pulls_ from it), a **workflow** (so CI _pushes_ to it), and the **`ATTIC_TOKEN` secret** (so the push authenticates). Do all three.

## Initial setup questionnaire

Before touching any files, use the **Ask tool** (`AskUserQuestion`) to settle the **trigger scope** — which branches should trigger a build-and-push?

- **Default branch only** — push on the default branch (`main`/`master`) plus `pull_request` and `workflow_dispatch`. Warms the cache from merged, reviewed code. Recommended for most repos.
- **All branches** — push on every branch too, so feature branches warm the cache. Costs more CI minutes and can push closures from unreviewed code.

Assume the user already has an `ATTIC_TOKEN` push token (they obtain it from the cache admin — Juspay infra — via `atticadm make-token`, scoped to the `oss` cache). Don't block on it here; step 3 confirms it's set on the repo and loops until it is.

## 1. Add the cache as a substituter

In the repo's top-level `flake.nix`, add (or extend) `nixConfig`:

```nix
nixConfig = {
  extra-substituters = "https://cache.nixos.asia/oss";
  extra-trusted-public-keys = "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=";
};
```

## 2. Add the workflow

Set the `on:` triggers to match the **trigger scope** answer from the questionnaire. The template below is the default-branch-only variant.

### Already have a `nix build` workflow? Piggyback on it.

If the repo already has a workflow that runs `nix build` (e.g. a CI job), **don't add a second one** — just drop the `ryanccn/attic-action` step into the existing job, *before* the build step, so its end-of-job hook pushes whatever that job builds:

```yaml
      - uses: ryanccn/attic-action@5635a15ef0c5462194ffbd05d1daeddc74625c3a # v0.5.0
        with:
          endpoint: https://cache.nixos.asia
          cache: oss
          token: ${{ secrets.ATTIC_TOKEN }}
```

The action pushes every store path realised during the job, so no explicit push step is needed. Only create the standalone `nix-cache.yml` below when there's no existing build job to hook into. (Note: if the existing job uses the DeterminateSystems installer rather than `nix-quick-install-action`, verify attic-action still finds a new-enough Nix for `nix profile add`.)

### Standalone workflow

Create `.github/workflows/nix-cache.yml`. `ryanccn/attic-action` handles install, login, substituter config, and pushing every store path the job produced at job end.

```yaml
# Build the default package on linux + darwin and push each closure to the
# shared Attic cache (https://cache.nixos.asia/oss).
name: nix-cache

on:
  push:
    branches: [master]   # set to the repo's default branch
  pull_request:
  workflow_dispatch:

# Least privilege — this job only needs the checkout and ATTIC_TOKEN secret.
permissions:
  contents: read

concurrency:
  group: nix-cache-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-and-push:
    strategy:
      fail-fast: false
      matrix:
        # ubuntu-latest → x86_64-linux; macos-latest → aarch64-darwin.
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      # Pin by commit (CodeQL: unpinned third-party action). v35 → 9f63be7.
      # v35 defaults to Nix 2.34.7, new enough for attic-action's `nix profile add`.
      - uses: nixbuild/nix-quick-install-action@9f63be77f412a248c9d9a65a4c82cf066cdf8f0c # v35
        with:
          nix_conf: |
            extra-substituters = https://cache.nixos.asia/oss
            extra-trusted-public-keys = oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=
            accept-flake-config = true

      - uses: ryanccn/attic-action@5635a15ef0c5462194ffbd05d1daeddc74625c3a # v0.5.0
        with:
          endpoint: https://cache.nixos.asia
          cache: oss
          token: ${{ secrets.ATTIC_TOKEN }}

      - name: Build
        run: nix build -L --print-out-paths
```

Rules:

- For **default branch only**, set the `push.branches` filter to the repo's actual default branch (kolu uses `master`; many repos use `main`). For **all branches**, drop the `branches:` filter so `push:` fires everywhere.
- Keep both actions **pinned by commit SHA** (CodeQL flags unpinned third-party actions). The `# v35` / `# v0.5.0` trailing comments record the tag. Prefer the SHAs above unless a newer release is needed; do not replace them with floating tags.

## 3. Set the ATTIC_TOKEN secret

The token is a repo secret you can't set for the user — it's their token, entered interactively so it stays out of shell history. **Give them this command and ask them to run it**, then confirm:

```bash
gh secret set ATTIC_TOKEN --repo <owner>/<repo>
```

`gh` prompts for the value interactively (never paste the token into a command line that gets logged). After they say they've run it, **re-check** and **re-ask until it's present**:

```bash
gh secret list --repo <owner>/<repo>   # ATTIC_TOKEN should appear
```

If it's missing, tell them and ask again — loop until `gh secret list` shows `ATTIC_TOKEN`. The workflow fails loudly without this secret; there is no silent skip.

## Verify

Push to the default branch (or trigger via **Actions → nix-cache → Run workflow**). A green run means the closure was pushed. To confirm the pull side works, on another machine run `nix build` and check the log shows paths fetched from `cache.nixos.asia/oss`.
