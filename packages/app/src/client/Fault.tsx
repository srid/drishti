/**
 * drishti's LOOK for an uncaught client throw — the markup half of the fault
 * surface whose catch/record/print half is `SurfaceFaultBoundary`
 * (`@kolu/surface-app/solid`), composed by `<SurfaceAppProvider fault={…}>` in
 * `./App.tsx` (kolu#2164). Without it a client that threw mid-render was a
 * white tab: Solid unmounts the subtree that faulted, and every error surface
 * drishti has — the transport overlay included — rides the tree that just came
 * down.
 *
 * The text is VERBATIM and scrollable rather than wrapped away: it is what a
 * bug report is made of. Reload rides the model: the boundary renders inside
 * the provider exactly so a LOOK can still read `useSurfaceApp()`, and the
 * model's `reload()` lands on the `no-store` shell → the current bundle —
 * which matters most here, since a stale bundle may be the very thing that
 * threw.
 */

import { useSurfaceApp } from "@kolu/surface-app/solid";

export function Fault(props: { readonly text: string }) {
  const app = useSurfaceApp();
  return (
    <main
      class="fixed inset-0 z-50 flex items-center justify-center bg-white p-8 dark:bg-gray-950"
      data-testid="client-fault"
    >
      <div class="max-w-3xl">
        <h1 class="mb-2 text-2xl font-bold text-red-600 dark:text-red-400">
          drishti broke
        </h1>
        <p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
          Something in this page threw while it was being drawn, so what was on
          screen is gone and nothing here will update again. Your fleet keeps
          running — nothing drishti draws touches it.
        </p>
        <pre
          class="mb-4 max-h-[50vh] max-w-full overflow-auto rounded border border-gray-300 bg-gray-50 p-3 font-mono text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          data-testid="client-fault-detail"
        >
          {props.text}
        </pre>
        <button
          type="button"
          class="rounded bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500"
          onClick={() => app.reload()}
        >
          Reload
        </button>
      </div>
    </main>
  );
}
