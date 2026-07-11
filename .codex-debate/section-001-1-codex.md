### Round 1

**codex** — approved: `false`

The agent→parent→browser alert flow is coherent, typechecks cleanly, and the 34 targeted alert/metrics/history/agent tests pass. However, first-time notification enablement is effectively broken on browsers requiring a user gesture, and there are several smaller correctness and lifecycle issues. The full suite was not clean in this read-only environment: temporary-directory tests hit EROFS and one unchanged process-stream test failed.

Findings:
- `F1` · major · open — Notification permission is requested automatically during component initialization, outside a user gesture. Browsers commonly suppress or reject such requests. Since `notify.show` is explicitly a no-op until permission is granted and there is no later user-triggered permission path, first-time users can receive no OS alerts at all. (packages/app/src/client/App.tsx:557)
- `F2` · minor · open — The promises returned by `setAppBadge` and `clearAppBadge` are discarded without rejection handling. Feature presence does not guarantee success; security, permission, or document-state failures can therefore produce unhandled promise rejections whenever this effect runs. (packages/app/src/client/App.tsx:587)
- `F3` · minor · open — The host-card alert count reads the raw cell without considering entry liveness. Cell subscriptions retain their last value across a dropped link, so a disconnected host continues showing an undimmed red "N alerts" indicator even though the badge correctly excludes that same stale value. This presents stale state as a live alert. (packages/app/src/client/App.tsx:760)
- `F4` · nit · open — `alertsEqual` is not true set equality when either array contains duplicates. Equal array lengths plus one-way membership can consider `{items:["cpu","mem"]}` equal to `{items:["cpu","cpu"]}`. The current producer emits unique IDs, but the schema and exported function do not enforce that invariant. (packages/common/src/alerts.ts:106)
- `F5` · nit · open — The lifecycle commentary says `emitMetrics` remains null until the derived cell's connect effect subscribes. In the pinned reactor implementation, `scan(...)` subscribes to the source synchronously during construction, before `derived.cell` connects, so this explanation of the guard and pre-connect behavior is incorrect. (packages/agent/src/main.ts:193)
