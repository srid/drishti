# drishti

A live process monitor that runs against any host you can `ssh` into. Browser SolidJS UI ↔ local parent server (Bun) ↔ remote agent over `ssh` stdio. Built on [`@kolu/surface`](https://kolu.dev/blog/surface-framework/) (with https://github.com/juspay/kolu/pull/984) for the typed reactive transport.

## Quick start

```sh
nix run github:srid/drishti                            # localhost (default)
nix run github:srid/drishti -- user@host               # one remote
nix run github:srid/drishti -- localhost a.lan b.lan   # multiple hosts (tabbed UI)
```

Open <http://localhost:7720>. The UI opens on the **fleet** tab — a single overview pane with one live summary card per host (connection state, CPU, memory, load average, uptime); click a card (or a host's tab) to drill into that host's full htop. Each host also has its own tab with a live connection-state dot.

Every view has its own URL, so you can bookmark or share a link straight to a host: selecting a host updates the address to <http://localhost:7720/?host=user@host> (the fleet overview is the bare <http://localhost:7720/>). Opening such a link, or reloading the page, lands directly on that host.

Use the `+ add host` button in the tab strip to add hosts at runtime; the `×` on each tab removes one. Added/removed hosts persist to `$XDG_STATE_HOME/drishti/hosts.json` (override with `DRISHTI_HOSTS_FILE`), so `nix run github:srid/drishti` with no args restores the last session.

Requirements:

- The remote host must be `ssh`-reachable with **passwordless** auth and a working **`nix-daemon`** that **trusts your user** (`trusted-users` in `nix.conf`) — drishti provisions the agent by shipping its `.drv` to the remote with `nix copy --derivation` and realising it there.
- Localhost works without any remote setup.

Mixed-architecture host sets are supported: the monitor wrapper bakes a `{system → drv}` map for `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`, and the parent probes each host's nix-system on add (via [`@kolu/surface-nix-host`'s `resolveSystem`](https://github.com/juspay/kolu/pull/1009), which asks the host's own Nix for `builtins.currentSystem`) to pick the matching `.drv`. A macOS user can drive a Linux remote (or both) from one `nix run` invocation.

## Architecture

```
Browser (SolidJS UI, tab strip)
   │  one WebSocket per host  ─────────┐
   ▼                                   ▼
Parent server (Bun, drishti)    Admin surface (host set)
   │  ssh stdio (oRPC) ×N
   ▼
Host 1: drishti-agent     Host 2: drishti-agent     …
   │  /proc on linux, sysctl on darwin
   ▼
Kernel
```

Host identity lives only at the transport layer: each browser tab opens its own WebSocket to `/rpc/ws?host=<id>`; the parent dispatches to a per-host `RPCHandler` (built once per host from the same surface schema). The per-host `surface` schema (system / processes / cpuCores / connection cells) is scalar — no host dimension anywhere in the primitives.

A separate **admin surface** at `/rpc/ws?host=__admin__` exposes the *set* of hosts as a `Collection<string, HostEntry>` plus `addHost` / `removeHost` procedures. The tab strip subscribes to the collection; the `+` / `×` buttons call the procedures.

Per-host primitives:

| Primitive | Path | Purpose |
|---|---|---|
| **Cell** | `system` | Load averages, memory, uptime, OS, hostname. |
| **Collection** | `processes` | Keyed by PID — `{ user, cpuPct, memPct, command, cwd }`. Snapshot-then-delta. `cwd` is from `/proc/<pid>/cwd` on linux (empty on darwin / kernel threads / other-user pids). |
| **Stream** | `processesSnapshot` | Bulk-snapshot variant for ~600-PID htop refresh in one frame. |
| **Collection** | `cpuCores` | Per-core CPU usage (`Collection<K,T>` showcase). |
| **Procedure** | `process.kill` | The only mutation — sends `TERM` / `KILL` / `HUP` / `INT`. |

Admin surface primitives:

| Primitive | Path | Purpose |
|---|---|---|
| **Collection** | `hosts` | Configured hosts; key = host string. |
| **Procedure** | `hosts.add` | Spin up a new host session; persists to the hosts file. |
| **Procedure** | `hosts.remove` | Tear down a host session; persists removal. |

## Development

```sh
just dev                          # parent server :7720, host=localhost
just dev user@somehost            # any ssh target with passwordless access
just dev localhost a.lan b.lan    # multiple hosts (per-host arch probe)
just typecheck                    # tsc --noEmit across the workspace
just fmt                          # nixpkgs-fmt everything *.nix
just nix-build                    # build the wrapped monitor binary
just regenerate-bun-nix           # after any bun.lock change
```

`just dev` exports `DRISHTI_AGENT_DRVS_JSON` (the per-system `.drv` map from the flake's `agentDrvsJson` attribute) and boots Bun in watch mode. The parent probes each host's nix-system on add (asking the host's own Nix for `builtins.currentSystem`) and picks the matching `.drv` from the map — so one dev session can mix architectures. The dev server invokes `buildClient()` at startup so a single `bun --watch` covers both server-TS and client-bundle rebuilds. Browser refresh is manual — there's no HMR.

The first connect to a fresh remote ships the agent closure over `ssh` (`nix copy --derivation` then `nix-store --realise`); subsequent connects reuse it. The progress is streamed to the browser via the `connection` cell.

## Project layout

```
drishti/
├─ flake.nix                  # one input: juspay/bun2nix (rawflake)
├─ default.nix                # composer — exposes drishti, drishti-agent, drishti-client
├─ shell.nix                  # mkShell + hydrate-script shellHook
├─ package.json               # bun workspaces ["packages/*"]
├─ bunfig.toml                # [install] linker = "hoisted"
├─ bun.nix                    # generated by bun2nix
├─ justfile
├─ npins/sources.json         # nixpkgs + kolu pins
├─ nix/
│  ├─ nixpkgs.nix
│  ├─ overlay.nix             # kolu-surface, kolu-surface-nix-host
│  ├─ env.nix                 # DRISHTI_KOLU_SURFACE{,_NIX_HOST}
│  └─ packages/
│     ├─ kolu-package.nix     # mkKoluPackage factory
│     └─ drishti/default.nix  # bun2nix build derivation
├─ scripts/
│  └─ hydrate-kolu-packages.sh
└─ packages/app/
   └─ src/
      ├─ agent/{main.ts, proc.ts}              # remote-side agent
      ├─ common/{surface.ts, admin-surface.ts} # per-host + admin surfaces
      ├─ server/                                # parent server
      │  ├─ main.ts                             #   multi-host WS dispatch
      │  ├─ router.ts                           #   per-host router fragment
      │  ├─ admin-router.ts                     #   host-set router fragment
      │  ├─ hostRegistry.ts                     #   per-host session pool
      │  ├─ archMap.ts                          #   compose kolu's resolveSystem with the drv map
      │  ├─ hostsStore.ts                       #   $XDG_STATE_HOME/drishti/hosts.json
      │  └─ build.ts                            #   client bundler
      └─ client/                                # SolidJS UI
         ├─ App.tsx                             #   MultiHostApp + TabStrip + HostView
         ├─ wire.ts                             #   surfaceForHost(host) + adminClient()
         └─ {main.tsx, index.html, styles.css}
```

### How `@kolu/surface` is wired

`@kolu/surface` and `@kolu/surface-nix-host` aren't on npm. They're vendored from the `juspay/kolu` repo via npins, exposed as Nix-store paths through `nix/overlay.nix`, and hydrated into `node_modules/@kolu/*` by `scripts/hydrate-kolu-packages.sh`. The hydrate script takes `(src, dest)` pairs so adding another `@kolu/*` package is a one-line addition to the overlay + env.

To bump the kolu pin:

```sh
nix shell nixpkgs#npins -c npins update kolu
```

### Why Bun.build, not Vite

The client bundler is a hand-rolled `Bun.build` pipeline (`packages/app/src/server/build.ts`) with a small `solidJsxPlugin` (babel-preset-solid + babel-preset-typescript). Same bundle code path runs in dev (server invokes it at startup) and Nix (build derivation runs it during `buildPhase`). Tailwind v4 compiles via `@tailwindcss/cli` as part of the same pipeline.

### CI

CI runs via [`juspay/justci`](https://github.com/juspay/justci). The canonical pipeline lives in `ci/mod.just`; runners are configured in `~/.config/justci/hosts.json`.

Two upstream issues currently shape how CI runs:

- **crates.io blocks `curl/*` User-Agent.** Every `crate-*.tar.gz` fetched by `bun2nix`'s rust dep tree fails its `pkgs.fetchurl` with HTTP 403. `ci/mod.just`'s `_prefetch-crates` recipe (`scripts/ci-prefetch-crates.sh`) sidesteps this by fetching missing crates with a Mozilla UA and injecting them via `nix-store --add-fixed`. Idempotent and content-addressed, so the workaround disappears the first time upstream fetchurl learns to set a non-curl UA — or once bun2nix's Rust deps fetch from `static.crates.io` directly. Tracking issue: TBD.
- **`srid-justci` (the x86_64-linux runner alias) is unreachable.** The Tailscale proxy returns `ERR not owner of srid-justci`, so the linux lane can't dial it. The `## CI command` in `.agency/do.md` overrides with `--host x86_64-linux=localhost` so `/do` runs on this machine instead. Restore the runner (or repoint `~/.config/justci/hosts.json`) to drop the override.

### License

AGPL-3.0-or-later (matches upstream `@kolu/surface`).
