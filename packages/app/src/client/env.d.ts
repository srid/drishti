// The build constant `__SURFACE_APP_COMMIT__` injected by build.ts's Bun.build
// `define` (the Bun-equivalent of surface-app's Vite plugin). The declaration
// lives in the library — reference it here once rather than redeclaring the
// global. resolveCommit() in build.ts and buildInfoServer() on the server both
// stamp the same commit, so this client constant is the third leg of the skew
// comparison.
/// <reference types="@kolu/surface-app/client" />
