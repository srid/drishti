/**
 * App-identity strings — the product name and the per-host identity that names
 * both the installed PWA and the browser tab.
 *
 * drishti is one server per host (it runs *on* the machine and ships agents to
 * remotes over SSH). kolu names itself after its server identity; drishti's
 * server identity is the host it runs on, so the app presents as `drishti@<host>`
 * — e.g. `drishti@zest`. That string is the single source for the served PWA
 * `name`/`short_name`/`id` (so installing drishti from two hosts gives two
 * distinct, separately-labelled apps) *and* the tab title (so a row of tabs
 * across hosts is self-labelling). The server forms it from `os.hostname()` and
 * bakes it into the manifest; the client reads it back from there — one site.
 *
 * Pure and DOM-free, so it's importable by both the client (App.tsx) and the
 * server (main.ts, which builds the manifest) and unit-testable without a DOM.
 * `APP_TITLE` is also the static pre-paint `<title>` in `index.html` — the
 * boot/fallback value shown before the manifest is read; `title.test.ts`
 * canaries that hand-authored copy against this constant.
 */

/** The product short name — the bare brand. The single source for the `@host`
 *  identity below, the long product title, and the un-importable name sites
 *  (the static `<title>`, `apple-mobile-web-app-title`, the static manifest). */
export const APP_NAME = "drishti";

/** The product title — the boot/fallback value before the per-host identity is
 *  known, and the fleet-wide default. */
export const APP_TITLE = `${APP_NAME} — remote process monitor`;

/** The app's per-host identity, e.g. `drishti@zest`. `host` is the machine the
 *  parent server runs on (`os.hostname()`). Used for the PWA `name`/`short_name`
 *  and the tab title, so each deployment is a distinct, self-labelling app. */
export function appNameForHost(host: string): string {
  return `${APP_NAME}@${host}`;
}
