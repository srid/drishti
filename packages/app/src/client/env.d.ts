// The shell-carried build commit `window.__SURFACE_APP_COMMIT__`, injected by
// `buildSurfaceClient` into the no-store HTML shell (NOT a bundler define inside
// a content-hashed asset — kolu#1319). The `Window` augmentation lives in the
// library; reference it here once rather than redeclaring the global. Read the
// value via `shellCommit()` from `@kolu/surface-app/lifecycle`. resolveCommit()
// in build.ts and buildInfoServer() on the server both stamp the same commit,
// so this client value is the third leg of the skew comparison.
/// <reference types="@kolu/surface-app/client" />
