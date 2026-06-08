/**
 * Full-viewport dim overlay for transport- and update-state — drishti's port of
 * kolu's `packages/client/src/rpc/TransportOverlay.tsx`, rendered in drishti's
 * own tailwind palette. surface-app provides the headless MODEL (`useSurfaceApp`);
 * the app renders the chrome.
 *
 * Two independent signals drive it, both off `useSurfaceApp()`:
 * - `status() === "down"` — the control-plane WebSocket dropped; show
 *   "Reconnecting…".
 * - `updateReady()` — a fresh client build is live (build skew OR a parent
 *   restart). The skew-OR-restart predicate lives in surface-app's model beside
 *   the `reload()` it gates, so this consumer just reads it.
 *
 * The card passes pointer events through (`pointer-events-none` on the dim,
 * `pointer-events-auto` on the card) so the process table stays scrollable
 * underneath — only the Reload button is interactive. drishti has no service
 * worker on the control plane, so `reload()` is a plain `location.reload()`
 * landing on the `no-store` shell → the current bundle.
 */

import { useSurfaceApp } from "@kolu/surface-app/solid";
import { Show } from "solid-js";

export function TransportOverlay() {
  const app = useSurfaceApp();
  const disconnected = () => app.status() === "down";

  return (
    <Show when={disconnected() || app.updateReady()}>
      <div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div
          class="pointer-events-auto max-w-sm rounded border border-gray-300 bg-white p-6 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
          data-testid="transport-overlay"
        >
          <Show
            when={disconnected()}
            fallback={
              <>
                <div class="mb-1 font-semibold text-gray-900 dark:text-gray-100">
                  App updated
                </div>
                <div class="mb-4 text-gray-600 dark:text-gray-400">
                  Reload to apply the latest version.
                </div>
                <button
                  type="button"
                  class="rounded bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500"
                  onClick={() => app.reload()}
                >
                  Reload
                </button>
              </>
            }
          >
            <div class="mb-1 font-semibold text-gray-900 dark:text-gray-100">
              Disconnected from server
            </div>
            <div class="text-gray-600 dark:text-gray-400">Reconnecting…</div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
