import { render } from "solid-js/web";
import App from "./App";
import { registerServiceWorker } from "./pwa";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
render(() => <App />, root);

// Make the app installable / offline-capable. No-op when the browser lacks
// service workers or the page isn't a secure context (plain-http LAN access).
registerServiceWorker();
