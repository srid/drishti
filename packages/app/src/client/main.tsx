import { retireServiceWorker } from "@kolu/surface-app/lifecycle";
import { MetaProvider } from "@solidjs/meta";
import { render } from "solid-js/web";
import App from "./App";
// NB: styles.css is NOT imported here. drishti delivers CSS via the
// `<link rel="stylesheet">` in index.html (built separately by the Tailwind
// CLI to a hashed `/assets/styles-<hash>.css`), not bundled through the JS
// entry — importing it would make Bun.build emit a second, partially-processed
// CSS asset that nothing references.

// Retire any legacy caching service worker a previous drishti build left
// registered (and drop its caches) before the app mounts. drishti no longer
// ships its own worker — surface-app serves a self-destructing `/sw.js` from
// the server, and this paired client call unregisters the old one on every
// load so a browser stuck on a cached `main.js` self-heals. This is the
// retirement half of the four-times-relitigated stale-client fix.
retireServiceWorker();

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
// `MetaProvider` collects the reactive `<Title>` / `<Meta>` nodes App renders
// and projects them onto the document head — the kolu app-shell pattern
// (client/index.tsx) for a host-aware tab title and a theme-tracking PWA
// `theme-color`.
render(
  () => (
    <MetaProvider>
      <App />
    </MetaProvider>
  ),
  root,
);
