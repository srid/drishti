/**
 * Per-host daemon dialog — identity + typed convergence + renew/reconnect.
 * Modeled on kolu kaval/padi info dialog SHAPE (not pixels).
 */
import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import type { DaemonStatus } from "../common/daemonStatus";
import {
  anomalyBanner,
  CHIP_TONE_CLASS,
  chipFromDaemonStatus,
  identityRows,
  outcomeSummary,
  type RenewUiState,
} from "./daemonStatusPresentation";

const dash = "—";

export const DaemonDialog: Component<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: string;
  status: DaemonStatus | null;
  renewState: RenewUiState;
  onRenew: () => void;
  onReconnect: () => void;
}> = (props) => {
  const chip = () => chipFromDaemonStatus(props.status);
  const banner = () => anomalyBanner(props.status?.anomaly ?? null);
  const rows = () => identityRows(props.status?.identity ?? null);
  const outcome = () => outcomeSummary(props.status?.outcome ?? null);

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        role="presentation"
        onClick={() => props.onOpenChange(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onOpenChange(false);
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Daemon status for ${props.host}`}
          class="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-start justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
            <div class="min-w-0">
              <div class="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Agent daemon
              </div>
              <div class="truncate font-mono text-[11px] text-gray-500">
                {props.host}
              </div>
            </div>
            <span
              class={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${CHIP_TONE_CLASS[chip().tone]}`}
            >
              {chip().label}
            </span>
          </div>

          <div class="space-y-3 px-3 py-3 text-xs text-gray-700 dark:text-gray-300">
            {/* U2.6: adopted-stale Renew nudge ONLY — never for boot-refused. */}
            <Show when={chip().showNudge}>
              <div
                class="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-900 dark:text-amber-200"
                role="status"
              >
                <div class="font-medium">Action needed</div>
                <div class="mt-0.5 text-amber-800/80 dark:text-amber-300/80">
                  Budget gave up — riding a stale resident build. Renew to drain
                  and replace when ready.
                </div>
              </div>
            </Show>

            {/* U2.6: boot-refused gets its own recovery copy (fix named cause; no Renew). */}
            <Show when={banner()?.bootRefusedMessage}>
              {(msg) => (
                <div
                  class="rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-800 dark:text-red-200"
                  role="status"
                >
                  <div class="font-medium">Agent boot refused</div>
                  <div class="mt-0.5 font-mono text-[10px] opacity-90">
                    {msg()}
                  </div>
                  <div class="mt-1 text-[10px] opacity-80">
                    Fix the named cause on the host (e.g. chmod 0700 the state
                    directory), then Reconnect. Renew cannot drain a daemon that
                    never started.
                  </div>
                </div>
              )}
            </Show>

            <Show
              when={(() => {
                const b = banner();
                return b !== null && b.bootRefusedMessage === undefined
                  ? b
                  : false;
              })()}
            >
              {(b) => (
                <div
                  classList={{
                    "rounded-md border px-2.5 py-1.5 text-[11px]": true,
                    "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200":
                      b().tone === "warn",
                    "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200":
                      b().tone === "down",
                  }}
                  role="status"
                >
                  <div class="font-medium">{b().title}</div>
                  <For each={[...b().evidence]}>
                    {(line) => (
                      <div class="mt-0.5 font-mono text-[10px] opacity-80">
                        {line}
                      </div>
                    )}
                  </For>
                </div>
              )}
            </Show>

            <Show when={outcome()}>
              {(o) => (
                <div class="font-mono text-[10px] text-gray-500">{o()}</div>
              )}
            </Show>

            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <For each={[...rows()]}>
                {(row) => (
                  <>
                    <dt class="text-gray-500">{row.label}</dt>
                    <dd class="min-w-0 truncate font-mono text-[11px]" title={row.value}>
                      {row.value || dash}
                    </dd>
                  </>
                )}
              </For>
              <dt class="text-gray-500">phase</dt>
              <dd class="font-mono text-[11px]">
                {props.status?.phase ?? dash}
              </dd>
            </dl>

            <Show when={props.renewState.kind !== "idle"}>
              <div
                classList={{
                  "rounded border px-2 py-1 text-[11px]": true,
                  "border-gray-300 text-gray-600":
                    props.renewState.kind === "pending",
                  "border-emerald-500/40 text-emerald-700 dark:text-emerald-300":
                    props.renewState.kind === "ok",
                  "border-red-500/40 text-red-700 dark:text-red-300":
                    props.renewState.kind === "error",
                }}
                role="status"
              >
                {props.renewState.kind === "pending" && "Renewing…"}
                {props.renewState.kind === "ok" && "Renew ok — reconnecting"}
                {props.renewState.kind === "error" &&
                  `Renew failed: ${props.renewState.error}`}
              </div>
            </Show>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 px-3 py-2 dark:border-gray-700">
            <button
              type="button"
              class="rounded border border-gray-300 px-2.5 py-1 text-[11px] font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
              onClick={() => props.onOpenChange(false)}
            >
              Close
            </button>
            <button
              type="button"
              class="rounded border border-gray-300 px-2.5 py-1 text-[11px] font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
              onClick={() => props.onReconnect()}
            >
              Reconnect
            </button>
            <button
              type="button"
              class="rounded border border-indigo-500/50 bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-800 hover:bg-indigo-500/20 dark:text-indigo-200"
              disabled={props.renewState.kind === "pending"}
              onClick={() => props.onRenew()}
            >
              Renew agent
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};
