/**
 * WebSocket `Origin` gate — the CSWSH (Cross-Site WebSocket Hijacking)
 * defense for the parent's `/rpc/ws` upgrade.
 *
 * The RPC surface carries no credentials, so a browser's same-origin policy
 * and SameSite cookies provide no protection: any web page the operator
 * happens to visit can open `ws://localhost:7720/rpc/ws?host=__admin__` and
 * — absent this check — drive the admin surface (read fleet telemetry, add
 * ssh hosts). The browser *does* attach an `Origin` header to that upgrade;
 * the only missing control is for the server to verify it.
 *
 * Policy:
 *   - No `Origin` header → allow. Non-browser clients (the CLI, tests,
 *     `curl`, a native app) don't send one and aren't a CSWSH vector;
 *     CSWSH is specifically a browser-driven attack.
 *   - `Origin`'s host:port equals the request's `Host` header → allow. This
 *     is the drishti UI talking to its own origin. A cross-site attacker
 *     page has a different host, so it's rejected.
 *   - `Origin` is in the explicit allowlist → allow. This is the escape
 *     hatch for reverse-proxy / `tailscale serve` setups where the browser
 *     origin (`https://box.tailnet.ts.net`) differs from the `Host` the
 *     proxy forwards. Operators opt in via `DRISHTI_ALLOWED_ORIGINS`.
 *   - Otherwise → reject.
 */

export interface WsOriginCheck {
  /** The request's `Origin` header (`undefined` if absent). */
  origin: string | undefined;
  /** The request's `Host` header (`undefined` if absent). */
  host: string | undefined;
  /** Exact-match origin allowlist from `DRISHTI_ALLOWED_ORIGINS`. */
  allowedOrigins: readonly string[];
}

export function isAllowedWsOrigin({
  origin,
  host,
  allowedOrigins,
}: WsOriginCheck): boolean {
  // Non-browser client: no Origin, not a CSWSH vector.
  if (origin === undefined || origin.length === 0) return true;
  // Operator-configured allowlist (reverse proxy / tailscale-serve FQDN).
  if (allowedOrigins.includes(origin)) return true;
  // Same-origin: the Origin's host:port must match the Host the request
  // arrived on. `URL.host` carries the port when non-default and omits it
  // when default, which mirrors the browser's `Host` header.
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Malformed or opaque (`"null"`) Origin — treat as cross-origin.
    return false;
  }
  return host !== undefined && host.length > 0 && originHost === host;
}

/** Parse the `DRISHTI_ALLOWED_ORIGINS` env value (comma-separated exact
 *  origins) into a trimmed, non-empty list. `undefined`/blank → `[]`. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
