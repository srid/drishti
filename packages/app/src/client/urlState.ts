/**
 * Serializes the {@link View} sum to and from the browser URL so every host
 * — and the fleet overview — has a shareable, bookmarkable address.
 *
 * The `View` signal in `App` is the source of truth; the URL is just its
 * projection. A selected host lives in the `?host=` query param, URL-encoded
 * so arbitrary ssh targets (`user@host`, `[::1]`, …) round-trip intact. The
 * bare path (no `host` param) is the fleet overview. Query params — not path
 * segments — keep reload working with zero server routing: every address
 * still resolves to `/`, which already serves the SPA.
 *
 * The two functions are pure (they take a search string rather than reading
 * `window.location`) so they unit-test without a DOM, matching the
 * `metrics` / `usageColors` pattern. Call sites pass `window.location.search`.
 */
import type { View } from "./view";

const HOST_PARAM = "host";

/** Parse a `location.search` string into the view it encodes. */
export function viewFromSearch(search: string): View {
  const host = new URLSearchParams(search).get(HOST_PARAM);
  return host ? { kind: "host", host } : { kind: "fleet" };
}

/** The `location.search` string (`""` or `"?host=…"`) that encodes a view. */
export function searchForView(view: View): string {
  if (view.kind === "fleet") return "";
  return `?${new URLSearchParams({ [HOST_PARAM]: view.host }).toString()}`;
}
