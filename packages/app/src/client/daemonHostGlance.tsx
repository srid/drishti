/**
 * Production glance placements for tab strip + fleet card (U3.4 / U4.3).
 *
 * These ARE the interactive structures HostCard / TabChip mount — not test
 * mirrors. Behavior tests render these components (with a store provider)
 * so re-nesting buttons in production reds the rendered tree.
 */
import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";
import type { EntryState } from "@kolu/surface-map";
import type { ConnectionInfo, ConnectionState } from "drishti-common/browser";
import { STATE } from "./connectionColors";
import { FleetDaemonStatusChip } from "./DaemonStatusChip";
import { HostDot } from "./HostDot";

const TAB_BASE =
  "flex shrink-0 items-center gap-1.5 border-r border-gray-200 px-2 py-1 text-xs dark:border-gray-800";
const TAB_INACTIVE =
  "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800/60";
const TAB_ACTIVE =
  "bg-white text-gray-900 shadow-[inset_0_-2px_0_0_theme(colors.indigo.500)] dark:bg-gray-900 dark:text-gray-100";

/** Tab-strip host chip: selection + fleet daemon chip as SIBLINGS (U3.4). */
export const TabHostGlance: Component<{
  host: string;
  active: boolean;
  connectionKind: string;
  alertCount: number;
  onSelect: () => void;
  onClose: () => void;
  /** HostDot state accessor — same EntryState lens TabChip uses. */
  entryState: () => EntryState<{ reason: string }, ConnectionInfo>;
}> = (props) => (
  <div
    class={`${TAB_BASE} ${props.active ? TAB_ACTIVE : TAB_INACTIVE}`}
    data-testid={`tab-chip-${props.host}`}
  >
    <button
      type="button"
      data-testid={`tab-select-${props.host}`}
      class="flex items-center gap-2"
      onClick={() => props.onSelect()}
      title={`${props.host} — ${props.connectionKind}`}
    >
      <HostDot state={props.entryState} />
      <span class="font-semibold">{props.host}</span>
      <Show when={props.connectionKind === "connected" && props.alertCount > 0}>
        <span
          data-testid={`tab-alert-${props.host}`}
          class="shrink-0 rounded-full bg-red-500/15 px-1.5 text-xs font-semibold text-red-600 dark:text-red-400"
          title={`${props.alertCount} alert${props.alertCount === 1 ? "" : "s"}`}
        >
          {props.alertCount}
        </span>
      </Show>
    </button>
    <FleetDaemonStatusChip host={props.host} />
    <button
      type="button"
      class="ml-1 text-gray-400 hover:text-red-500"
      title={`Remove ${props.host}`}
      onClick={(e) => {
        e.stopPropagation();
        props.onClose();
      }}
    >
      ×
    </button>
  </div>
);

/** Fleet-card chrome: selection + daemon chip siblings; body is a separate control. */
export const HostCardGlance: Component<{
  host: string;
  connectionPhase: ConnectionState;
  alertCount: number;
  entryState: () => EntryState<{ reason: string }, ConnectionInfo>;
  onSelect: () => void;
  children?: JSX.Element;
}> = (props) => (
  <div
    data-testid={`host-card-${props.host}`}
    class="flex flex-col gap-2 rounded border border-gray-200 bg-gray-50 p-3 transition-colors hover:border-indigo-400 hover:bg-white dark:border-gray-800 dark:bg-gray-900/40 dark:hover:border-indigo-500 dark:hover:bg-gray-900"
  >
    <div class="flex items-center gap-2">
      <button
        type="button"
        data-testid={`host-card-select-${props.host}`}
        onClick={() => props.onSelect()}
        class="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <HostDot state={props.entryState} class="shrink-0" />
        <span class="truncate font-semibold" title={props.host}>
          {props.host}
        </span>
        <Show
          when={
            props.entryState().kind === "connected" && props.alertCount > 0
          }
        >
          <span
            class="shrink-0 rounded-full bg-red-500/15 px-1.5 text-xs font-semibold text-red-600 dark:text-red-400"
            title={`${props.alertCount} alert${props.alertCount === 1 ? "" : "s"}`}
          >
            {props.alertCount}
          </span>
        </Show>
        <span class={`ml-auto shrink-0 text-xs ${STATE[props.connectionPhase].text}`}>
          {props.connectionPhase}
        </span>
      </button>
      <FleetDaemonStatusChip host={props.host} />
    </div>
    <button
      type="button"
      data-testid={`host-card-body-${props.host}`}
      onClick={() => props.onSelect()}
      class="flex w-full flex-col gap-2 text-left"
    >
      {props.children}
    </button>
  </div>
);
