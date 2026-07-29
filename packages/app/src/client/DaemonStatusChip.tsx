/**
 * Per-host daemon status chip — kaval-style glance status.
 * Presentation from chipFromDaemonStatus only (no string parsing).
 */
import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";
import type { DaemonStatus } from "../common/daemonStatus";
import {
  type DaemonChipPresentation,
  CHIP_TONE_CLASS,
  chipFromDaemonStatus,
} from "./daemonStatusPresentation";
import { useDaemonStatusStore } from "./daemonStatusStore";

export const DaemonStatusChip: Component<{
  status: DaemonStatus | null | undefined;
  onClick?: () => void;
  /** Optional override for tests. */
  presentation?: DaemonChipPresentation;
}> = (props) => {
  const p = (): DaemonChipPresentation =>
    props.presentation ?? chipFromDaemonStatus(props.status);
  return (
    <button
      type="button"
      data-testid="daemon-status-chip"
      class={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-4 ${CHIP_TONE_CLASS[p().tone]}`}
      title={`Daemon: ${p().label}${p().showNudge ? " — action needed" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick?.();
      }}
    >
      <span
        classList={{
          "h-1.5 w-1.5 shrink-0 rounded-full": true,
          "bg-emerald-500": p().tone === "ok",
          "bg-amber-500": p().tone === "warn" || p().tone === "warming",
          "bg-red-500": p().tone === "down",
          "bg-gray-400": p().tone === "muted",
          "animate-pulse": p().tone === "warming",
        }}
      />
      <span data-testid="daemon-status-chip-label">{p().label}</span>
      <Show when={p().showNudge}>
        <span class="rounded bg-amber-600/20 px-1 text-[9px] uppercase tracking-wide">
          renew
        </span>
      </Show>
    </button>
  );
};

/**
 * Fleet-bound chip — reads status + dialog open from the shared store.
 * Used as a SIBLING of host-selection controls (U3.4: never nested in a button).
 * MUTATION: status={null} here fails the rendered binding test (U3.2).
 */
export const FleetDaemonStatusChip: Component<{ host: string }> = (props) => {
  const store = useDaemonStatusStore();
  const status = () => store.byHost()[props.host] ?? null;
  return (
    <DaemonStatusChip
      status={status()}
      onClick={() => store.setDialogHost(props.host)}
    />
  );
};

/** Compact chip for fleet card row (same presentation). */
export const DaemonStatusChipInline: Component<{
  status: DaemonStatus | null | undefined;
  class?: string;
  children?: JSX.Element;
}> = (props) => (
  <span class={props.class}>
    <DaemonStatusChip status={props.status} />
    {props.children}
  </span>
);
