/**
 * PWA service-worker registration. Kept out of `main.tsx` so the render
 * bootstrap stays about rendering and this stays about the install
 * lifecycle — and so the guard logic is unit-testable without a DOM.
 *
 * The worker itself is the static `public/sw.js`, served from the root so
 * its scope covers the whole app.
 */

/** True when the runtime can host a service worker: the API exists and the
 *  page is a secure context. drishti is normally opened at
 *  `http://localhost` (a secure context per the spec), but reaching it at a
 *  plain-http LAN address is not — there we silently skip rather than throw. */
export function canRegisterServiceWorker(
  nav: { serviceWorker?: unknown } | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
  secure: boolean = typeof window !== "undefined" && window.isSecureContext,
): boolean {
  return secure && nav !== undefined && "serviceWorker" in nav;
}

/** Register `/sw.js` once the page has loaded, if the runtime supports it.
 *  Registration failures are swallowed — a missing service worker degrades
 *  to a plain (non-installable) web app, never a broken one. */
export function registerServiceWorker(): void {
  if (!canRegisterServiceWorker()) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* SW unavailable — app still works, just not installable/offline */
    });
  });
}
