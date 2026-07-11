fix(lens): delete the hollow app/common/metrics re-export barrel

After the pct helpers moved to drishti-common/metrics, this module was a pure
redirect encapsulating no volatility — a backward-compat shim, which the design
philosophy calls a defect to remove. Delete it and repoint its last consumer
(client/metrics.ts) directly at drishti-common/metrics; history.ts already
resolves there. One home, no redirect.

Agreed by the lowy ⇄ hickey lens debate (finding lowy-3, raised by lowy). Not pushed or merged.
