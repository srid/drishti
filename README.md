# drishti

**htop for your whole fleet — with nothing installed on the remote.** If you can `ssh` into a host and its Nix daemon trusts you, you can watch its live processes, CPU, memory, disk, and network. drishti ships its own agent *over the SSH connection* on first connect — no package to install, no inbound port to open, no daemon to configure on the far end.

Browser (SolidJS) ↔ local parent server (Bun) ↔ remote agent over `ssh` stdio, on the typed reactive transport [`@kolu/surface`](https://kolu.dev/blog/surface-framework/) + [oRPC over ssh](https://kolu.dev/blog/orpc-over-ssh/).

## Demo

▶ **[Watch drishti in action](https://x.com/sridca/status/2060333167463088637)** — a short screencast demoing the multi-host fleet view and live htop drill-down.

Screenshots:

<img width="1081" height="774" alt="image" src="https://github.com/user-attachments/assets/77c83113-7b13-4387-99b4-a4e60777d638" />

<img width="1081" height="774" alt="image" src="https://github.com/user-attachments/assets/b5b11751-2bc8-4866-aa8c-16068124e2fe" />


## Why drishti

- **Zero install on the remote.** The agent closure is shipped over SSH (`nix copy --derivation` then realise) on first connect and reused after. The agent is built from its own minimal derivation, so editing the UI or parent server doesn't change its hash — a drishti upgrade doesn't force a fresh closure copy on the next reconnect. The remote needs only passwordless `ssh` + a `nix-daemon` that trusts your user — no agent binary to install, no inbound port, no config file to drop.
- **Zero config locally.** No database, no persisted metrics, no setup. History lives in memory for the life of the process. `nix run` and you're watching.
- **One pane, many hosts, mixed arch.** A macOS laptop can drive Linux *and* macOS remotes from a single `nix run` — drishti probes each host's Nix system and ships the matching build.
- **Cross-OS, same numbers.** Linux (`/proc`) and macOS (`sysctl` / `vm_stat` / `netstat`) report the same metrics the same way — memory "used" is cache-aware on both.

## Quick start

```sh
nix run github:srid/drishti                            # localhost (default)
nix run github:srid/drishti -- user@host               # one remote
nix run github:srid/drishti -- localhost a.lan b.lan   # multiple hosts (tabbed UI)
```

Open <http://localhost:7720>. The UI opens on the **fleet** tab — a single overview pane with one live summary card per host (connection state, CPU, memory, disk, load average, uptime, and a 30m CPU/memory/disk history sparkline); click a card (or a host's tab) to drill into that host's full htop. Every view has its own URL, so you can bookmark or share a link straight to a host: selecting a host updates the address to <http://localhost:7720/?host=user@host> (the fleet overview is the bare <http://localhost:7720/>), and opening such a link — or reloading — lands directly on that host. The browser tab is titled after the **host drishti itself runs on** — `drishti@<hostname>` (e.g. `drishti@zest`) — so a row of tabs (or installed apps) watching different fleets is self-labelling rather than five identical `drishti` tabs.

> [!IMPORTANT]
> **drishti is single-user software.** It is meant to run on your own machine and be reached from that machine — it binds `127.0.0.1` (loopback) by default. Its RPC surface is **unauthenticated** (no accounts, sessions, or access control), so drishti is **not** designed to be exposed to the internet or shared between users. If you put it on a public address or a shared network you do so **at your own risk** — prefer a trusted private overlay such as [`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve), and see [Deployment](#deployment-home-manager) for the `--bind` and origin-allowlist knobs.

## Features

- **Live time-series charts** (CPU% / memory% / disk%) over a rolling 1m / 5m / 15m / 30m window, switched by a segmented control. The parent server samples every host on each poll tick — whether or not a tab is open — so the chart survives page reloads and tab switches and is already populated the first time you open a host. The **fleet overview** carries the same trend at a glance: each host card shows a compact **30m** CPU/memory/disk sparkline drawn from the same ring (pinned to the widest window, no per-card picker). History is in-memory only; restarting the parent starts fresh. Disk is root-filesystem (`/`) fullness — a slow-moving capacity gauge, not disk I/O. A tab left in the **background** pauses its live views after ~20s and shows a "Paused" placeholder — a hidden tab can't display telemetry, so it stops decoding the 2s frames for it; because the *parent* keeps sampling regardless, the full history is intact the instant the tab is back in view.
- **Runtime host management** — the `+ add host` button adds hosts, the `×` on each tab removes one. Added/removed hosts persist to `$XDG_STATE_HOME/drishti/hosts.json` (override with `DRISHTI_HOSTS_FILE`), so `nix run github:srid/drishti` with no args restores the last session.
- **Per-host view memory** — the chart window, process sort column, and process filter stick across reloads via `localStorage`, remembered per host. A **light/dark toggle** (top-right of the tab strip) overrides the OS theme and is remembered globally; until you touch it, the theme follows your system preference. The address-bar / installed-app tint (the PWA `theme-color`) tracks the *chosen* theme — driven reactively from the in-app toggle rather than the OS media query — so it stays in step even when the toggle overrides the system preference.
- **Click a process for details** — selecting a row opens an inline panel above the table with the full (untruncated) command and working directory, exact CPU% and resident memory (plus its share of host RAM), and per-process metadata: parent PID, kernel state, nice value, thread count, and start time. The parent PID is a link when that process is still in the live set — click it to jump the panel to the parent (selecting its row). Click the row again, the `✕`, or press `Esc` to close. Thread count and start time are linux-only (darwin's `ps` has no cheap source — they're omitted there).
- **Idle NICs collapse** behind a `+N idle` toggle by default, so the few interfaces moving traffic aren't buried under the dozens of always-zero virtual ones (utunN, anpiN, …).
- **Strictly read-only** — drishti only ever *observes* a host. The per-host surface exposes no procedures, so there is no way to signal, kill, or otherwise mutate a monitored process through the UI or the wire.
- **Installable PWA, one per host** — drishti ships a web app manifest and an emerald aperture icon, so you can install it as a standalone app (desktop, or a phone's home screen). The manifest's name and identity are the server's own `drishti@<hostname>`, so installing drishti from two different hosts gives you **two distinct, separately-labelled apps** in the OS app list — not one ambiguous `drishti` that collides. The shell and its assets are served by [`@kolu/surface-app`](https://github.com/juspay/kolu/tree/master/packages/surface-app) under a strict freshness contract (see below); drishti ships **no caching service worker** of its own. A **Pin app** button in the tab strip surfaces the install prompt directly — it appears only on a secure origin (`https://…`, e.g. a `tailscale serve` FQDN) and hides once drishti is already installed, gated on the `canInstallPwa` / `isInstalled` signals from `@kolu/surface-app`'s `useSurfaceApp()` and rendered via [`@kolu/solid-pwa-install`](https://github.com/juspay/kolu/tree/master/packages/solid-pwa-install) (which owns the cross-browser install volatility). <sub>The button is gated behind `TODO(pin)` until the kolu pin tracks the in-flight `welcome` revision that ships those signals + that package — see the draft-PR note below.</sub>
- **Always the deployed build** — drishti adopts `@kolu/surface-app`, which owns the *freshness contract* on the wire: the HTML shell is served `no-store`, the content-hashed `/assets/*` bundle and stylesheet are pinned `immutable` for a year, an asset miss 404s (never the HTML shell under a `.js` URL), and the server serves a self-destructing `/sw.js` that unregisters any legacy caching worker an earlier drishti build left behind. The client's build commit (carried on the `no-store` HTML shell as `window.__SURFACE_APP_COMMIT__`, read via `shellCommit()` — never baked into an `immutable` bundle, which a stamp-only deploy would leave stale; kolu#1319) rides a `buildInfo` cell on the admin surface alongside the server's resolved commit; both commits — plus a server-connection liveness dot — are always visible in a slim status footer pinned to the bottom of the viewport, and when a tab is provably behind the deployed build the footer grows a `≠ srv` one-tap reload affordance. A returning installed client thus always re-fetches the shell and converges to the deployed build — the stale-client class of bug, gone structurally.

Requirements:

- The remote host must be `ssh`-reachable with **passwordless** auth and a working **`nix-daemon`** that **trusts your user** (`trusted-users` in `nix.conf`) — drishti provisions the agent by shipping its `.drv` to the remote with `nix copy --derivation` and realising it there.
- Localhost works without any remote setup.

**Hosts behind a bastion (SSH hops).** drishti runs plain `ssh <host>`, so a host reachable only *through* a jump box needs no drishti config — just an `~/.ssh/config` entry with `ProxyJump`:

```
Host db-internal
  HostName 10.0.0.5
  ProxyJump bastion.example.com
```

Then add `db-internal` like any other host. The agent spawn, the nix-system probe, and the `nix copy` of the agent closure all hop through the bastion automatically. The jump host must itself be non-interactive from where drishti runs (drishti forces `BatchMode=yes`), so a bastion that prompts for a password fails rather than hangs — use a key.

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
   │  /proc on linux; sysctl + vm_stat / netstat / ps / lsof on darwin
   ▼
Kernel
```

Host identity lives only at the transport layer: each browser tab opens its own WebSocket to `/rpc/ws?host=<id>`; the parent dispatches to a per-host `RPCHandler` (built once per host from the same surface schema). The per-host `surface` schema (system / processes / cpuCores / networkInterfaces / connection cells) is scalar — no host dimension anywhere in the primitives.

A separate **admin surface** at `/rpc/ws?host=__admin__` exposes the *set* of hosts as a `Collection<string, HostEntry>` plus `addHost` / `removeHost` procedures. The tab strip subscribes to the collection; the `+` / `×` buttons call the procedures.

Per-host primitives:

| Primitive | Path | Purpose |
|---|---|---|
| **Cell** | `system` | Load averages, memory, disk, uptime, OS, hostname. Memory *used* means the same thing on every OS — total minus a cache-aware *available* (reclaimable file cache / inactive / purgeable pages don't count as used): `MemAvailable` from `/proc/meminfo` on linux, derived from `vm_stat` on darwin (since macOS `os.freemem()` counts only truly-free pages and would over-report a healthy Mac at 80-95%). Disk is **root-filesystem (`/`) bytes used/total** via the `statfs` syscall — the one capacity source universal across linux and darwin (no `/proc` file exposes free space). It reports `/` only by design; a host that splits `/var` or `/data` onto separate disks won't see those here (a per-mount view would be a future `diskDevices` collection, mirroring `networkInterfaces`). |
| **Collection** | `processes` | Keyed by PID — `{ user, cpuPct, rssBytes, command, cwd, ppid, state, nice, threads, startedAtMs }`. The table shows absolute resident memory (`rssBytes`, auto-scaled to MB/GB); the rest surface in the click-to-open detail panel. Snapshot-then-delta. `cwd` is from `/proc/<pid>/cwd` on linux and a single batched `lsof -d cwd` on darwin (empty for kernel threads, and for other-user pids without root — `readlink` EACCES on linux, no `lsof` cwd line on darwin). `ppid` / `state` / `nice` come from `/proc/<pid>/stat` on linux and `ps -o ppid=,nice=,state=` on darwin; `threads` and `startedAtMs` are linux-only (`/proc/<pid>/stat` thread count + boot-time-derived start), `null` on darwin (no cheap source). |
| **Stream** | `processesSnapshot` | Bulk-snapshot variant for ~600-PID htop refresh in one frame. |
| **Collection** | `cpuCores` | Per-core CPU usage (`Collection<K,T>` showcase). |
| **Collection** | `networkInterfaces` | Per-NIC network I/O, keyed by interface name — `{ rxBytes, txBytes, rxRate, txRate }` (cumulative bytes since boot + bytes/sec throughput). `/proc/net/dev` on linux, `netstat -ib` on darwin; loopback filtered out. The UI strip collapses idle interfaces (both rates 0) behind a `+N idle` toggle by default, so the few NICs moving traffic aren't buried under the dozens of always-zero virtual ones (utunN, anpiN, …). |

The per-host surface is **read-only** — cells, collections, and streams only, no procedures. The only procedures anywhere live on the separate admin surface below (host-set management), never on a monitored host.

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

`just dev` exports `DRISHTI_AGENT_DRVS_JSON` (the per-system `.drv` map from the flake's `agentDrvsJson` attribute) and boots Bun in watch mode. The parent probes each host's nix-system as part of bringing the host up — asking the host's own Nix for `builtins.currentSystem` — and picks the matching `.drv` from the map, so one dev session can mix architectures. The probe runs inside the connection's spawn cycle, so a host that's unreachable when the probe fires (offline remote, stale ssh-agent) folds into the same retry path as any other connection failure rather than aborting startup. The dev server invokes `buildClient()` at startup so a single `bun --watch` covers both server-TS and client-bundle rebuilds. Browser refresh is manual — there's no HMR.

The first connect to a fresh remote ships the agent closure over `ssh` (`nix copy --derivation` then `nix-store --realise`); subsequent connects reuse it. The realised closure is pinned behind a per-host GC root on the remote, so a `nix-collect-garbage` there can't delete the agent out from under a live session or force a rebuild on the next reconnect. The progress is streamed to the browser via the `connection` cell, and the overlay shows how long the current phase has been running ("Connecting… 18s") so a slow connect reads as abnormal. A dropped link reconnects automatically (the tab pulses amber, "Reconnecting…"), and what happens next depends on *why* it's down. If the host is simply **unreachable** — offline, asleep, or you've roamed onto a different network — drishti keeps retrying indefinitely at a capped backoff (the overlay reads "Host unreachable — retrying…"), so the link comes back on its own once the host is reachable again, no clicking. Only a **remote rejection** — the host answered but its `nix-daemon` won't accept the closure because your user isn't in `trusted-users` — is treated as terminal: after a few attempts the host enters a **failed** state, since retrying can't fix a misconfiguration. drishti then shows the underlying error, the captured connection log (the real `nix copy`/`ssh` output — not a guess at the cause), and a **Reconnect** button that re-arms the session in place, so you don't have to restart the parent. A connect that comes up but never completes its first RPC — transport alive, handshake wedged — is timed out by a watchdog rather than hanging in "connecting" forever. A host that's unreachable from the very start — offline when the monitor launches — just keeps retrying while every reachable host is monitored normally, instead of one bad host crashing the monitor before its HTTP port is even bound.

Because drishti is usually run on a laptop, it also recovers from **sleep**: close the lid at home, reopen at a café, and the parent detects the wake and immediately re-probes every host's link rather than waiting ~30s for each stale SSH connection to notice it's dead. The browser does the same when it regains connectivity (`online`) or you refocus the tab.

## Deployment (home-manager)

A home-manager module runs the monitor as a systemd user service on Linux and as a launchd LaunchAgent on macOS:

```nix
{
  imports = [ drishti.homeManagerModules.default ];
  services.drishti = {
    enable = true;
    package = drishti.packages.${system}.default;
    port = 7720;                  # default
    hosts = [ "user@host-a" ];    # optional; empty = manage hosts at runtime
  };
}
```

The monitor binds **`127.0.0.1` (loopback) by default** — its RPC surface is unauthenticated, so out of the box it is reachable only from the machine drishti runs on. To reach it from elsewhere, front it with a trusted reverse proxy (e.g. `tailscale serve`, which forwards to loopback), or — behind a firewall — bind all interfaces explicitly with `--bind 0.0.0.0` (`services.drishti.bind = "0.0.0.0"`, or the `DRISHTI_BIND` env var). When a proxy serves the UI from a different origin than the `Host` drishti receives, allowlist that origin via `services.drishti.allowedOrigins` (the `DRISHTI_ALLOWED_ORIGINS` env var) so the browser's WebSocket clears the same-origin check. `hosts` are passed as positional arguments; leave it empty to let drishti seed from its persisted hosts file (`$XDG_STATE_HOME/drishti/hosts.json`, overridable via `services.drishti.hostsFile`) and manage the set from the admin surface. The packaged wrapper already bakes `DRISHTI_DIST_DIR` / `DRISHTI_AGENT_DRVS_JSON` and puts `openssh` + `nix` on `PATH`, so the service self-contains its runtime needs.

See [`nix/home/example/`](nix/home/example/) for a full configuration — a NixOS VM test exercises the systemd path on Linux, and a standalone home-manager activation build exercises the launchd path on Darwin.

On macOS, the LaunchAgent writes stdout to `~/Library/Logs/drishti.out.log` and stderr to `~/Library/Logs/drishti.err.log`, so crashes and startup failures leave logs alongside other user logs. Every stderr line is timestamped (ISO-8601) and tagged by subsystem — `[server]`, `[hosts]`, `[admin]`, and one `[bridge:<host>]` per monitored host — so a connection problem can be traced to a specific host on a timeline (on Linux/systemd, `journalctl --user -u drishti` adds its own timestamps).

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
│  ├─ packages/
│  │  ├─ kolu-package.nix          # mkKoluPackage factory
│  │  ├─ drishti/default.nix       # monitor + client build (full app tree)
│  │  └─ drishti-agent/default.nix # scoped agent build — minimal inputs (issue #38)
│  └─ home/
│     ├─ module.nix           # home-manager module (systemd / launchd)
│     └─ example/             # example config — CI-built (VM + launchd checks)
├─ scripts/
│  └─ hydrate-kolu-packages.sh
└─ packages/                  # bun workspace members ["packages/*"]
   ├─ common/src/surface.ts                     # per-host wire contract — agent + monitor share it
   ├─ agent/src/{main.ts, proc.ts}              # remote-side agent (its own scoped build)
   └─ app/
      └─ src/
         ├─ common/{metrics.ts, history.ts, admin-surface.ts}  # monitor-internal shared (admin surface + metric math)
         ├─ server/                             # parent server
         │  ├─ main.ts                          #   multi-host WS dispatch
         │  ├─ router.ts                        #   per-host router fragment
         │  ├─ admin-router.ts                  #   host-set router fragment
         │  ├─ hostRegistry.ts                  #   per-host session pool
         │  ├─ archMap.ts                       #   compose kolu's resolveSystem with the drv map
         │  ├─ hostsStore.ts                    #   $XDG_STATE_HOME/drishti/hosts.json
         │  └─ build.ts                         #   client bundler
         └─ client/                             # SolidJS UI
            ├─ App.tsx                          #   MultiHostApp + TabStrip + HostView
            ├─ wire.ts                          #   surfaceForHost(host) + adminClient()
            └─ {main.tsx, index.html, styles.css}
```

### How `@kolu/surface` is wired

`@kolu/surface`, `@kolu/surface-nix-host`, `@kolu/surface-app`, and `@kolu/solid-pwa-install` aren't on npm. They're vendored from the `juspay/kolu` repo via npins, exposed as Nix-store paths through `nix/overlay.nix`, and hydrated into `node_modules/@kolu/*` by `scripts/hydrate-kolu-packages.sh`. The hydrate script takes `(src, dest)` pairs so adding another `@kolu/*` package is a one-line addition to the overlay + env — as `@kolu/solid-pwa-install` demonstrates.

> **Draft-PR note (this branch):** the **Pin app** install affordance depends on in-flight kolu work on branch `welcome`: the `canInstallPwa` / `isInstalled` signals on `useSurfaceApp()`, and the `@kolu/solid-pwa-install` package's source. Until the kolu pin in `npins/sources.json` tracks the merged `welcome` revision, the button stays off behind the `PWA_INSTALL_WIRED` guard in `src/client/TabStrip.tsx` and the `@kolu/solid-pwa-install` import stays commented. The nix wiring to hydrate the package is already in place; landing it is a pin bump + flipping the guard + uncommenting the import.

> **Draft-PR note:** `@kolu/surface-app` is not yet pinned via npins. While this lands, `just install` hydrates it from a **local kolu worktree** (`DRISHTI_KOLU_SURFACE_APP`, defaulted in the `install` recipe). For the merge: add surface-app to `npins/sources.json` (the existing kolu source already carries it) + `nix/env.nix` exactly like the other two `@kolu/*` packages, drop the local default, and regenerate `bun.nix`.

To bump the kolu pin:

```sh
nix shell nixpkgs#npins -c npins update kolu
```

### Why Bun.build, not Vite

The client bundler is a hand-rolled `Bun.build` pipeline (`packages/app/src/server/build.ts`) with a small `solidJsxPlugin` (babel-preset-solid + babel-preset-typescript). Same bundle code path runs in dev (server invokes it at startup) and Nix (build derivation runs it during `buildPhase`). Tailwind v4 compiles via `@tailwindcss/cli` as part of the same pipeline.

### CI

CI runs via [odu](https://github.com/juspay/odu) — "a CI runner you attach to" — invoked straight from upstream (`nix run github:juspay/odu -- run`). odu ships its own generic lane runner (`nix copy`d to remote lanes), so this repo re-exports nothing. The canonical pipeline is the `[metadata("ci")]` DAG in `ci/mod.just`; it builds every flake output, type-checks, checks formatting + `bun.nix` freshness, asserts agent `.drv` stability, and boots the home-manager example. Lane hosts come from `~/.config/odu/hosts.json` (falling back to `~/.config/justci/hosts.json`); a live run is attachable (`nix run github:juspay/odu -- attach`) and agents drive it through odu's MCP server (`mcp__odu__*`).

One upstream issue currently shapes how CI runs:

- **crates.io blocks `curl/*` User-Agent.** Every `crate-*.tar.gz` fetched by `bun2nix`'s rust dep tree fails its `pkgs.fetchurl` with HTTP 403. `ci/mod.just`'s `_prefetch-crates` recipe (`scripts/ci-prefetch-crates.sh`) sidesteps this by fetching missing crates with a Mozilla UA and injecting them via `nix-store --add-fixed`. Idempotent and content-addressed, so the workaround disappears the first time upstream fetchurl learns to set a non-curl UA — or once bun2nix's Rust deps fetch from `static.crates.io` directly. Tracking issue: TBD.

### Binary cache

Builds are pushed to Juspay's shared OSS Attic cache at [`cache.nixos.asia/oss`](https://cache.nixos.asia). The `.github/workflows/nix-cache.yml` workflow builds the default package on linux + darwin for every push and PR and pushes each closure via [`ryanccn/attic-action`](https://github.com/ryanccn/attic-action). The cache is wired in as a substituter through the flake's `nixConfig`, so a local `nix build` pulls prebuilt closures instead of rebuilding — accept the flake config (`accept-flake-config = true`, or answer `y` when prompted) to opt in.

### License

AGPL-3.0-or-later (matches upstream `@kolu/surface`).
