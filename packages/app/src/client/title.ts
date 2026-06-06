/**
 * Document-title policy — the single source of truth for what the browser
 * tab (and the installed-PWA window) is named.
 *
 * kolu derives its tab title from server identity (`<Title>{appTitle()}</Title>`
 * over `@solidjs/meta`); drishti is a fleet monitor, so the natural identity to
 * surface is *which host is on screen*. A host view names the host so a row of
 * pinned drishti tabs/windows is self-labelling ("user@host — drishti"); the
 * fleet overview has no single host, so it keeps the full product title.
 *
 * Pure and view-only: the reactive plumbing (reading `selectedHost`, feeding
 * `<Title>`) lives in `App.tsx`. This module owns only the *string*, so the
 * format is unit-testable without a DOM. `APP_TITLE` is also the static
 * pre-paint `<title>` in `index.html`; `title.test.ts` canaries that
 * hand-authored copy against this constant, mirroring how `brand.test.ts`
 * pins the un-importable brand-color sites.
 */

/** The product short name — the bare brand. The single source for every place
 *  "drishti" appears as a name: the host-view title suffix, the long product
 *  title below, the PWA `short_name`, and `apple-mobile-web-app-title`. A rename
 *  is one edit here rather than several hand-kept literals that can diverge. */
export const APP_NAME = "drishti";

/** The product title — the fleet-overview title and the boot/pre-mount value. */
export const APP_TITLE = `${APP_NAME} — remote process monitor`;

/** The document title for the current view: the selected host (so the tab
 *  identifies the machine) or the product title when none is selected (fleet). */
export function titleForHost(host: string | null): string {
  return host ? `${host} — ${APP_NAME}` : APP_TITLE;
}
