# Web app performance — Ralph optimisation log

User complaint: "It is so laggy right now." Switching between hosts and
interacting with the live process list feels slow. This document is the
running log of the measurement‑driven optimisation pass.

## Goal

Optimise the SolidJS browser UI of `drishti` so:

1. Lighthouse desktop **Performance score** is high (primary metric).
2. **Tab switches** between hosts feel instantaneous (INP).
3. The process table stays smooth as snapshots stream in (no jank during
   the per‑tick re‑renders of 200–600 rows).

Constraint from the user: **visible UI behaviour must not change.**
Everything else (data structures, memoisation strategy, DOM shape under
the hood, wire payload, deps) is fair game.

## Methodology

- Hosts: `just dev localhost sincereintent` — two hosts so tab switching is exercisable.
- Browser: Chromium driven by `chrome-devtools` MCP, default desktop emulation.
- Cold load: navigate fresh (`navigate_page` + reload) then trace.
- Lighthouse: `lighthouse_audit(device: "desktop", mode: "navigation")` — note:
  the MCP wrapper excludes the perf category, so the perf score comes from
  the trace summary, not the Lighthouse JSON.
- Per cycle: profile (trace), classify the biggest contributor, mutate,
  re‑measure. Commit only if the improvement exceeds noise.

## Baseline

Cold load (`navigate_page` + reload, two hosts, `localhost` connected & ~470 rows, `sincereintent` disconnected):

- **LCP**: 185 ms · **CLS**: 0.00 · **TTFB**: 3 ms · render delay: 182 ms

Sustained streaming (5-run median over 6 s windows, 469 rows):

| metric | value | notes |
|---|---|---|
| `p99 frame` | **27 ms** | one or two skipped frames per second |
| `max frame` | **147 ms** | quarter-second freeze on snapshot tick |
| `ltMax` (worst long task) | **139 ms** | the snapshot delta render |
| `ltTotal` (all long tasks / 6 s) | **269 ms** | ≈4.5 % of wall time blocked |
| `TBT-like` (sum of `>50ms − 50ms` / 6 s) | **119 ms** | |
| `ltCount` | **3 / 6 s** | one per snapshot tick |
| tab-switch click→2× rAF | **10–20 ms** | not a real issue |

Root cause (validated): a `MutationObserver` on `<tbody>` recorded **43,357
`<tr>` additions and 43,353 removals in 6 seconds** while only **28 text-node
characterData changes** fired. The `<For>` in `<ProcessTable>` keys on row
object identity, and `visibleRows()` allocates fresh `{ pid, proc }` objects
every memo run, so every snapshot tick tears down and rebuilds the entire
~470-row DOM. The "lag" the user feels is this teardown + rebuild, every poll.

## Optimisation log

| # | Change | p99 frame | max frame | ltMax | ltTotal/6s | TBT-like/6s | Notes |
|---|--------|-----------|-----------|-------|------------|-------------|-------|
| baseline | _none_ | 27 | 147 | 139 | 269 | 119 | 469 rows |
| 1 | `<For>` keyed by PID + per-cell reactive reads | 27 | 112 | 97 | 244 | 94 | DOM rebuilds → moves only; mutation count when sort=PID went 43 k → 0 per 6 s with 74 text updates. |
| 2 | Wrap delta loop in `batch()` | **18** | **18** | **0** | **0** | **0** | Without batch each `setProcesses(pid, value)` in the for-loop fired its own reactive cycle, re-running `visiblePids` ~460 times per tick and dragging the `<For>` through intermediate orderings. Per-6 s tr moves: 27 495 → 67. All long tasks gone. |
| 3 | `minify: true` in `Bun.build` | 18 | 23 | 0 | 0 | 0 | Client bundle 674 KB → 377 KB (-44 %). LCP unchanged on localhost (185 → 194 ms = noise) but ¼ wire payload helps on real networks and trims JS parse cost on slower devices. Sourcemap stays linked so DevTools still resolves originals. |

## Findings

_(Filled in as cycles complete.)_

## Dead ends

_(Filled in as cycles complete.)_
