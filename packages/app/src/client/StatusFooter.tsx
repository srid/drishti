/**
 * Status footer — the `srv · client` identity readout as a slim, viewport-fixed
 * status bar (the VS Code / tmux placement). It used to live in the tab strip
 * as an `ml-auto` pill, where it wrapped onto an orphaned, mostly-empty second
 * row as soon as the host tabs filled the strip's width; a bottom bar can never
 * collide with the tabs, and `fixed` strengthens the rail's always-visible
 * contract — the readout now survives page scroll too.
 *
 * `srv` (left) is the control-plane connection: a liveness dot (from
 * surface-app's headless `status()`) plus the server's build commit; `client`
 * (right) is the commit this browser's bundle was baked from, flagging `≠ srv`
 * (one-tap reload) when the two clean refs provably disagree. Distinct from
 * the per-host SSH `connection` dots on the tab chips. `MultiHostApp` reserves
 * matching bottom padding on the page wrapper so content never hides under the
 * bar; the `pb` tracks `safe-area-inset-bottom` for the installed-PWA case
 * (phone home-indicator zone). z-20 keeps it under the z-50 TransportOverlay.
 */

import { isCleanRef } from "@kolu/surface-app";
import { type ConnectionStatus, useSurfaceApp } from "@kolu/surface-app/solid";
import { Show } from "solid-js";

const SRV_DOT: Record<ConnectionStatus, string> = {
  live: "bg-emerald-500",
  reconnecting: "bg-amber-500 animate-pulse",
  restarted: "bg-amber-500 animate-pulse",
  down: "bg-red-500",
};

export function StatusFooter() {
  const pwa = useSurfaceApp();
  return (
    <footer class="fixed inset-x-0 bottom-0 z-20 flex items-center justify-between border-t border-gray-200 bg-gray-50/95 px-3 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1 font-mono text-xs backdrop-blur dark:border-gray-800 dark:bg-gray-950/95">
      <span class="inline-flex items-center gap-1.5">
        <span class="text-[9px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
          srv
        </span>
        <span
          title="Server connection"
          data-ws-status={pwa.status()}
          class={`inline-block h-[7px] w-[7px] rounded-full ${SRV_DOT[pwa.status()]}`}
        />
        <Commit sha={pwa.server()?.commit} />
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="text-[9px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
          client
        </span>
        <span title="This browser's JS build (baked in at build time)">
          <Commit sha={pwa.clientCommit} />
        </span>
        <Show when={pwa.stale()}>
          <button
            type="button"
            title="This client build doesn't match the server — reload to pick up the server's version."
            onClick={pwa.reload}
            class="rounded-full border border-amber-400/50 px-1.5 text-[9px] leading-4 text-amber-600 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/30"
          >
            ≠ srv
          </button>
        </Show>
      </span>
    </footer>
  );
}

const DRISHTI_REPO_URL = "https://github.com/srid/drishti";

// A git-commit cell (kolu's `ui/Commit.tsx`, ported): the short SHA links to
// its GitHub commit page when the ref is clean and navigable, plain text
// otherwise (a dirty / dev / absent ref — never a broken `-dirty` link).
function Commit(props: { sha: string | undefined }) {
  const linkable = () => isCleanRef(props.sha);
  return (
    <Show
      when={linkable()}
      fallback={
        <span class="text-gray-600 dark:text-gray-300">{props.sha || "—"}</span>
      }
    >
      <a
        href={`${DRISHTI_REPO_URL}/commit/${props.sha}`}
        target="_blank"
        rel="noopener noreferrer"
        class="text-gray-600 underline decoration-dotted underline-offset-2 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
      >
        {props.sha}
      </a>
    </Show>
  );
}
