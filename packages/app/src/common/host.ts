/**
 * Host identity — what a drishti "host" string is, and which strings are
 * admissible as one.
 *
 * This is a volatility axis of its own, distinct from the admin wire
 * surface that consumes it: it changes when ssh-spawn semantics change (a
 * new injection vector, OpenSSH adopting a `--` separator) or when the
 * reserved-id scheme changes — not when an admin procedure is added. It
 * lives here, in its own module, because three unrelated callers depend on
 * it (the admin wire input, the persisted-file load, and the CLI), and
 * only one of them is the admin surface.
 */

/** Reserved string used as the `host=` query value for the admin surface
 *  (the control-plane WebSocket at `/rpc/ws?host=__admin__`). It is a
 *  syntactically valid ssh destination, so `isValidHost` must reject it
 *  explicitly to keep it from colliding with a real host name. */
export const ADMIN_HOST_SENTINEL = "__admin__";

/** Is `host` admissible as a drishti host (an ssh destination)?
 *
 *  The one place that decides "what may become a host", shared by every
 *  ingestion boundary — the admin `hosts.add` wire input (`HostInputSchema`
 *  in `admin-surface.ts`), the persisted-file load (`hostsStore`), and the
 *  CLI args (`server/main.ts`). Centralising it keeps the boundaries from
 *  drifting: a string that one path admits, all paths admit.
 *
 *  The load-bearing rule is `!startsWith("-")`. drishti hands the host
 *  string to `ssh` as a *bare positional* (`ssh <opts> <host> <cmd>`), so a
 *  value beginning with `-` is parsed by ssh as an *option*, not a
 *  destination — e.g. `-oProxyCommand=<cmd>` makes ssh run `<cmd>` via
 *  `/bin/sh` to "establish the connection". A no-whitespace filter does not
 *  stop that: a single-token payload (`-oProxyCommand=reboot`) has no
 *  whitespace, and the `$IFS` form reintroduces argument separation at ssh's
 *  own shell. Rejecting a leading `-` closes the injection at the boundary,
 *  independent of whether the ssh argv ever gains a `--` separator. A real
 *  ssh destination never starts with `-` (interior dashes — `db-internal`,
 *  `a.lan` — are fine), so this rejects no legitimate target.
 *
 *  The sentinel exclusion rides here too: `__admin__` is ssh-safe (no dash,
 *  no whitespace) but reserved for control-plane routing, so the single
 *  predicate is the one enforcement point for "a valid host is never the
 *  routing sentinel" — keeping that invariant from fragmenting across the
 *  three call sites. */
export function isValidHost(host: string): boolean {
  return (
    host.length > 0 &&
    host !== ADMIN_HOST_SENTINEL &&
    !/\s/.test(host) &&
    !host.startsWith("-")
  );
}
