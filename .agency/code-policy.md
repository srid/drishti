# Code policy

Project-specific rules the agent (and humans) must uphold. Keep entries
concrete and tied to a real incident, not abstract principle.

## Errors must reach the user, never the void

A failure the user can act on must surface where the user looks — the UI,
or a log the user actually reads. Swallowing it, or replacing it with a
guess, is a bug.

### Banned

- **`.catch(() => {})` / empty `catch {}` that drops an actionable error.**
  Logging to the browser console is **not** user-visible — the console is
  a developer surface. If a user-triggered action can fail, the user must
  be able to tell that it failed.
- **Fire-and-forget calls whose only failure mode is a silent no-op**,
  with the caller (or RPC) reporting success regardless. If an action can
  fail to take effect, its effect — or its failure — must be observable.
  _Incident:_ the "Reconnect" button. `HostSession.reconnect()` returned
  `void`, the admin RPC returned `{ ok: true }` unconditionally, and a
  session that silently failed to re-arm looked re-armed. Nothing moved,
  nothing logged.
- **Speculative "tips" / remediation text shown unconditionally, decoupled
  from the actual error.** A hint that may not apply is noise that buries
  the real cause. _Incident:_ the failed-host card hardcoded a
  "your user probably isn't in `trusted-users`" tip for every failure,
  regardless of whether that was the cause — while the real `nix copy`
  stderr sat unused in the connection log.

### Required

- Prefer surfacing the **real captured failure output** over a
  hand-written guess about what went wrong.
- When state is streamed (a connection/status cell, a snapshot-then-delta
  channel), let that stream be the **single source of truth** for
  success/failure. Don't bolt on a parallel return value that can disagree
  with it.
- If you must catch-and-continue for control flow, the error still has to
  land somewhere a human will see it — a state cell, a surfaced log, a
  toast.
- A speculative hint is allowed only when gated on a **structured signal**
  that actually identifies the cause (e.g. a `failureCause` discriminant),
  never on the mere fact that *some* failure occurred.
