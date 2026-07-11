## [⚖️ Lowy ⇄ Hickey lens debate](https://kolu.dev/blog/hickey-lowy/)

✅ **Consensus** after 1 round(s) · lowy + hickey · base `18fce74e184e`

Independent findings: lowy=4, hickey=4

### Applied (6)
- `lowy-1` Metric-identity vocabulary and system→% projection duplicated across two homes — commit `06f50e136`
- `lowy-2` Presentation label rides the agent-shared wire — layering inversion + third label table — commit `30af5a3d6`
- `lowy-3` common/metrics.ts is now a hollow re-export barrel encapsulating no volatility — commit `0cf3b1a7c`
- `hickey-1` AlertItem.pct is dead data shipped across the whole wire — commit `9e2225b20`
- `hickey-2` label is a pure projection of id, denormalized onto the wire and reconstituted client-side — (uncommitted)
- `hickey-3` With pct and label gone, AlertItem is a one-field wrapper — the honest shape is AlertId[] — commit `ae95f9328`

### Agreed — no change (2)
- `lowy-4` HostCard opens a second per-host alerts subscription alongside the eager watcher (packages/app/src/client/App.tsx:756)
- `hickey-4` Per-host alert count derived from two independent subscriptions to the same cell (packages/app/src/client/App.tsx:760 (HostCard) vs :557/:582 (watchByEntry + badge))