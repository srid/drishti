/**
 * Brand colors — the single source of truth for drishti's two surface
 * colors. The dark value doubles as the PWA background/theme color and the
 * icon background; the light value is the light-theme page background.
 *
 * The icon generator derives its pixels from these constants, so the icons
 * can't drift. CSS (styles.css), HTML (index.html), and JSON
 * (manifest.webmanifest) can't import TypeScript, so they repeat the
 * literals — brand.test.ts canaries those hand-authored sites against these
 * constants so a rename surfaces as a test failure rather than silent drift.
 */
export const BRAND_DARK = "#0b0d12";
export const BRAND_LIGHT = "#f7f8fb";
