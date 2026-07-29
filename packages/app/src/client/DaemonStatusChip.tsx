/**
 * Per-host daemon status chip + always-present dialog glyph (kaval shape).
 *
 * - Loud status chip: anomaly-only on glance surfaces (quiet when healthy —
 *   no second green "running" pill beside the connection label).
 * - Glyph: ALWAYS present on host entries so the daemon dialog stays reachable
 *   when the loud chip is hidden. No status text; no connection-label duplicate.
 *
 * Presentation from chipFromDaemonStatus only (no string parsing).
 */
import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";
import type { DaemonStatus } from "../common/daemonStatus";
import {
  type DaemonChipPresentation,
  CHIP_TONE_CLASS,
  chipFromDaemonStatus,
  chipGlanceVisible,
} from "./daemonStatusPresentation";
import { useDaemonStatusStore } from "./daemonStatusStore";

/**
 * Subtle always-present dialog entry — icon only, no status text.
 * Sibling of host selection (U3.4: never nested in another button).
 */
export const DaemonDialogGlyph: Component<{
  onClick?: () => void;
  /** Accessible name / tooltip — never a status word. */
  title?: string;
}> = (props) => (
  <button
    type="button"
    data-testid="daemon-dialog-glyph"
    class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-200"
    title={props.title ?? "Daemon details"}
    aria-label={props.title ?? "Daemon details"}
    onClick={(e) => {
      e.stopPropagation();
      props.onClick?.();
    }}
  >
    {/* Hex ring — reads as "daemon/identity", not a connection phase. */}
    <svg
      viewBox="0 0 16 16"
      class="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <path d="M8 1.5 13.5 4.5v7L8 14.5 2.5 11.5v-7L8 1.5Z" />
      <circle cx="8" cy="8" r="1.75" fill="currentColor" stroke="none" />
    </svg>
  </button>
);

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
 * Fleet-bound glance control: ALWAYS glyph (dialog entry) + LOUD chip only
 * when it adds daemon-only fact beyond the connection label (kaval).
 * Used as a SIBLING of host-selection controls (U3.4: never nested in a button).
 * MUTATION: drop the glyph ⇒ healthy fleet has no dialog entry (human review red).
 * MUTATION: status={null} on the loud chip path fails the rendered binding test.
 */
export const FleetDaemonStatusChip: Component<{ host: string }> = (props) => {
  const store = useDaemonStatusStore();
  const status = () => store.byHost()[props.host] ?? null;
  const open = () => store.setDialogHost(props.host);
  const loud = () => chipGlanceVisible(chipFromDaemonStatus(status()));
  return (
    <span
      class="inline-flex items-center gap-1"
      data-testid="fleet-daemon-glance"
    >
      <DaemonDialogGlyph onClick={open} />
      <Show when={loud()}>
        <DaemonStatusChip status={status()} onClick={open} />
      </Show>
    </span>
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
