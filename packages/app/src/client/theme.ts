/**
 * Light/dark theme: a persisted override on top of the OS preference.
 *
 * Tailwind's `dark:` variant is rebound (in `styles.css`) to the
 * `data-theme="dark"` attribute on `<html>` rather than the
 * `prefers-color-scheme` media query, so a click can flip the theme
 * without touching OS settings. The chosen theme is saved to
 * `localStorage` and re-applied on the next visit.
 *
 * To avoid a flash of the wrong theme, the attribute is set *before first
 * paint* by a tiny inline script in `index.html` (it can't import this
 * module — modules load after paint). That script is the single reader of
 * storage at startup; here, {@link initialTheme} seeds the signal from the
 * attribute the script already applied, keeping JS state and the DOM in
 * lockstep.
 *
 * Theme is global app chrome, so the signal lives in `App` (like `view`),
 * not per host.
 */

export type Theme = "light" | "dark";

/**
 * Storage key for the theme override. Must stay in sync with the literal
 * in `index.html`'s pre-paint bootstrap, which runs before any module can
 * import this constant.
 */
export const THEME_KEY = "drishti:theme";

/** Narrow an arbitrary string to a {@link Theme}, or null if it is neither. */
export function parseTheme(raw: string | null): Theme | null {
  return raw === "light" || raw === "dark" ? raw : null;
}

/** The OS-level preference — the default before the user picks a theme. */
export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Theme to seed the signal with: the attribute the pre-paint bootstrap
 * already applied, falling back to the OS preference if that script didn't
 * run (e.g. storage threw). Reading the live attribute keeps the signal
 * agreeing with what's already on screen.
 */
export function initialTheme(): Theme {
  return (
    parseTheme(document.documentElement.dataset.theme ?? null) ?? systemTheme()
  );
}

/** The other theme — what a toggle switches to. */
export function otherTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

/**
 * Apply a theme to the document. This module owns the *how* — which element
 * and attribute carry the theme — so that detail stays in one place. The
 * *when* (and persistence) is the caller's reactive effect, keeping the
 * theme signal the single source of truth.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
