/**
 * Pure numeric metric derivations shared across tiers: the browser uses
 * them for the header / fleet-card usage bars, and the parent uses them to
 * build the metric-history ring (`common/history.ts`). Kept framework-free
 * — `import type` erases the surface dependency so they carry no zod /
 * @kolu runtime weight and stay trivially unit-testable.
 *
 * UI-only formatting (GB strings, uptime, byte sizes) lives in
 * `client/metrics.ts`, which re-exports these two so existing client
 * imports keep resolving against one module.
 */

// `averageCoreUsage`, `pctOf`, `memPct`, and `diskPct` all live in the
// agent-shared `drishti-common/metrics` — the one home the agent (and its
// `alerts` fold) can import (`averageCoreUsage` moved there when the agent became
// the host-CPU-aggregate producer; the share-of-total helpers followed so no tier
// re-derives them). Re-exported here so the app-tier consumers (`common/history.ts`,
// `client/metrics.ts`) keep resolving `pctOf`/`memPct`/`diskPct` against one module.
export { diskPct, memPct, pctOf } from "drishti-common/metrics";
