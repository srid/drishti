import { retireServiceWorker } from "@kolu/surface-app/lifecycle";
import { MetaProvider } from "@solidjs/meta";
import { render } from "solid-js/web";
import App from "./App";
// NB: styles.css is NOT imported here. drishti delivers CSS via the
// `<link rel="stylesheet">` in index.html, which Vite (@tailwindcss/vite)
// processes into a hashed `/assets/styles-<hash>.css` — importing it through
// the JS entry too would emit a duplicate CSS asset.

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
