/**
 * Brand colors — the single source of truth for drishti's two surface
 * colors. The dark value doubles as the PWA background/theme color and the
 * icon background; the light value is the light-theme page background.
 *
 * TypeScript sites import these constants directly, so they can't drift: the
 * icon generator derives its pixels from them, and App.tsx's reactive
 * `theme-color` <Meta> selects between them via {@link brandColorForTheme}.
 * CSS (styles.css) and the JSON manifest
 * (manifest.webmanifest) can't import TypeScript, so they repeat the literals —
 * brand.test.ts canaries those hand-authored sites against these constants so a
 * rename surfaces as a test failure rather than silent drift. (index.html no
 * longer carries a brand color: its theme-color meta is now the reactive
 * <Meta>.)
 */
import type { Theme } from "./theme";

export const BRAND_DARK = "#0b0d12";
export const BRAND_LIGHT = "#f7f8fb";

/**
 * The brand surface color for a theme — the policy behind the reactive PWA
 * `theme-color`. It lives here, beside the two values it selects between,
 * rather than as an inline ternary at the call site: a third theme would then
 * be one exhaustive edit here, not a case silently missed in JSX. The symmetric
 * twin of title.ts's `titleForHost` — a pure mapping over a domain enum.
 */
export function brandColorForTheme(theme: Theme): string {
  return theme === "dark" ? BRAND_DARK : BRAND_LIGHT;
}
