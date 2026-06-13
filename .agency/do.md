# /do config

## Check command
bun run typecheck

## Format command
just fmt

## Test command
bun test

## CI command
The runner is **odu** (`github:juspay/odu`, which replaced justci — it ships
its own lane runner, so this repo re-exports nothing). Prefer odu's MCP server
to start and watch runs —
`mcp__odu__run` then `mcp__odu__wait_for_settle` (fail-fast), drilling into a
red node's log and `mcp__odu__rerun_node` to close a check. Use the `/ci` skill
for the underlying CLI, flags, and run mechanics.

<!-- Host routing: `$ODU_HOSTS` → `~/.config/odu/hosts.json` (falls back to
`~/.config/justci/hosts.json`). aarch64-darwin → rasam. For the x86_64-linux
lane, route the platform to one of the `pu` boxes (`pu create <NAME>` to
provision a fresh one if none is warm). -->

<!-- Push before CI: odu's remote lanes `git fetch` the pushed HEAD SHA from
origin (no git-bundle transport), so an unpushed commit can't run on rasam or a
pu box. The /do flow pushes before the CI step — keep it that way. -->

<!-- Never pass `--no-post` / `--no-strict` / `--no-snapshot` for a real CI run:
those skip the GitHub status posts that update the PR's checks. -->



## Documentation
Keep `README.md` in sync with user-facing changes.

## PR evidence

When the change has visible UI impact, post a `## Evidence` PR comment with screenshots. Use judgment — server-only diffs (host wiring, RPC plumbing) sometimes ripple into rendering and sometimes don't.

**Delegate to a subagent** (`Agent(subagent_type="general-purpose", model="sonnet")`) so the main context stays clear of MCP and screenshot noise. Brief it with: the dev-server URL, what scenarios to capture, a `/tmp/drishti-evidence-<slug>.png` filename, and the PR number. Have it return only the markdown body it should post — the calling `/do` posts it with `gh pr comment`.

### Dev server

Spawn a dedicated dev server on a **free random port** (the user may already have one on 7720). The `port` flag — or `PORT` env var — is the override; both flow through `cli` in `packages/app/src/server/main.ts` and default to 7720.

```sh
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); p=s.getsockname()[1]; s.close(); print(p)')
PORT=$PORT just dev localhost &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT
# wait for the server to print "listening on :$PORT" before driving the browser
```

For "before" shots on a bug fix, run a second server from a `git worktree` on `master` on a different free port. Never stash the PR branch.

### Capture, host, post

The subagent drives `chrome-devtools` MCP — `new_page` at `http://localhost:$PORT/`, waits for the htop table to populate (the agent needs one poll tick to seed the snapshot, ~2s), reproduces the relevant state, `take_screenshot` to `/tmp/drishti-evidence-<slug>.png`.

`gh pr comment` can't attach binaries, so upload to a long-lived `evidence-assets` GitHub release on this repo and embed the download URL inline:

```sh
gh release view evidence-assets >/dev/null 2>&1 || \
  gh release create evidence-assets --prerelease \
    --title "Evidence assets (auto-uploaded by /do)" --notes "Do not delete."
gh release upload evidence-assets /tmp/drishti-evidence-<slug>.png --clobber
```

URL pattern: `https://github.com/srid/drishti/releases/download/evidence-assets/<filename>`. Use the single-quoted heredoc pattern (`<<'EOF'`) when posting so backticks and `$` survive unescaped.

### Process-table scenarios

The interesting surface for drishti is the live process table — load average, memory, CPU strip, and the per-PID rows. Most PRs touching the UI want a capture of the table in its normal state, plus one for any new column / filter / dialog the diff introduces.

Common scenarios worth a frame:

- **Default load** — the table populated with ~hundreds of rows; proves the agent → parent → browser pipeline is alive end-to-end.
- **Filtered view** — type into the filter input; capture the "showing N of M" counter shrinking.
- **Sort change** — click a sortable header (PID / USER / CPU% / MEM%) and capture the descending indicator.
- **Connecting overlay** — for changes that touch the `connection` cell (copying / connecting / disconnected states), spawn against an unreachable remote and capture the overlay.
- **Multi-host tabs** — for changes that touch the admin surface or tab strip, launch with multiple hosts (`just dev localhost a.lan`) and capture the tab strip + connection dots.

For PRs that add a per-process field (cwd, threads, fds, …), the default evidence is a **screenshot of the process table showing the new field for representative real processes** — that single frame proves the field flows schema → agent → wire → renderer end-to-end.
