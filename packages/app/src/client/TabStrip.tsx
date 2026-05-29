/**
 * Tab strip — list of configured hosts plus an "+ add host" affordance.
 *
 * Each chip subscribes to its host's `connection` cell from `wire.ts`
 * so the dot color reflects the live link state without polling. Dot
 * color is a function of `ConnectionState`; there is no parallel
 * status enum to keep in sync.
 *
 * Pure display: per-host socket disposal is driven by `MultiHostApp`'s
 * host-removal effect, NOT by this component's `onCleanup`. Mixing the
 * two would give a view component authority over transport lifetime
 * (Lowy L4); centralising in the parent keeps the chip a pure function
 * of its props plus its connection cell.
 */

import { createMemo, createSignal, For, Show } from "solid-js";
import type { View } from "./App";
import { type ConnectionState, DEFAULT_CONNECTION } from "../common/surface";
import { DOT_BG, isPendingState } from "./connectionColors";
import { surfaceForHost } from "./wire";

// Shared chip chrome — the fleet tab and the host chips are the same
// visual control, so the class strings live in one place rather than
// being copied into each component.
const TAB_BASE =
  "flex items-center gap-2 border-r border-gray-200 px-3 py-1.5 text-xs dark:border-gray-800";
const TAB_INACTIVE =
  "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800/60";
const TAB_ACTIVE =
  "bg-white text-gray-900 shadow-[inset_0_-2px_0_0_theme(colors.indigo.500)] dark:bg-gray-900 dark:text-gray-100";

export function TabStrip(props: {
  hosts: readonly string[];
  activeTab: View;
  onSelectFleet: () => void;
  onSelect: (h: string) => void;
  onAdd: (h: string) => Promise<string | null>;
  onRemove: (h: string) => Promise<void>;
}) {
  return (
    <div class="flex flex-wrap items-stretch border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/60">
      <FleetTab
        active={props.activeTab.kind === "fleet"}
        count={props.hosts.length}
        onSelect={props.onSelectFleet}
      />
      <For each={props.hosts}>
        {(host) => (
          <TabChip
            host={host}
            active={
              props.activeTab.kind === "host" && props.activeTab.host === host
            }
            onSelect={() => props.onSelect(host)}
            onClose={() => props.onRemove(host)}
          />
        )}
      </For>
      <AddHostForm onAdd={props.onAdd} />
    </div>
  );
}

// The leftmost chip: a fixed "fleet" tab that shows the aggregate
// overview of every host at once. It carries no connection dot of its
// own (it has no single host) — just a host count — and can't be closed.
function FleetTab(props: {
  active: boolean;
  count: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      class={`${TAB_BASE} ${props.active ? TAB_ACTIVE : TAB_INACTIVE}`}
      onClick={props.onSelect}
      title="Fleet overview — all hosts at a glance"
    >
      <span aria-hidden="true">▦</span>
      <span class="font-semibold">fleet</span>
      <span class="text-gray-400">({props.count})</span>
    </button>
  );
}

function TabChip(props: {
  host: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const app = surfaceForHost(props.host);
  const connection = app.cells.connection.use({});
  const state = createMemo<ConnectionState>(
    () => (connection.value() ?? DEFAULT_CONNECTION).state,
  );

  return (
    <div class={`${TAB_BASE} ${props.active ? TAB_ACTIVE : TAB_INACTIVE}`}>
      <button
        type="button"
        class="flex items-center gap-2"
        onClick={props.onSelect}
        title={`${props.host} — ${state()}`}
      >
        <span
          class={`inline-block h-2 w-2 rounded-full ${DOT_BG[state()]} ${isPendingState(state()) ? "animate-pulse" : ""}`}
        />
        <span class="font-semibold">{props.host}</span>
      </button>
      <button
        type="button"
        class="ml-1 text-gray-400 hover:text-red-500"
        title={`Remove ${props.host}`}
        onClick={(e) => {
          e.stopPropagation();
          void props.onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}

function AddHostForm(props: {
  onAdd: (h: string) => Promise<string | null>;
}) {
  const [open, setOpen] = createSignal(false);
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  const close = () => {
    setOpen(false);
    setValue("");
    setError(null);
    setPending(false);
  };

  const submit = async () => {
    const host = value().trim();
    if (host.length === 0) return;
    setPending(true);
    setError(null);
    const err = await props.onAdd(host);
    setPending(false);
    if (err === null) close();
    else setError(err);
  };

  return (
    <div class="flex items-center px-2 py-1.5 text-xs">
      <Show
        when={open()}
        fallback={
          <button
            type="button"
            class="rounded border border-gray-300 px-2 py-0.5 font-semibold text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            title="Add host"
            onClick={() => setOpen(true)}
          >
            + add host
          </button>
        }
      >
        <form
          class="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            type="text"
            class="w-48 rounded border border-gray-300 bg-gray-50 px-2 py-0.5 focus:border-emerald-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800"
            placeholder="user@host or hostname"
            autofocus
            disabled={pending()}
            value={value()}
            onInput={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
            }}
          />
          <button
            type="submit"
            class="rounded border border-emerald-500 bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:bg-emerald-950/40 dark:text-emerald-300"
            disabled={pending() || value().trim().length === 0}
          >
            add
          </button>
          <button
            type="button"
            class="px-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
            onClick={close}
          >
            cancel
          </button>
          <Show when={error()}>
            {(msg) => <span class="ml-2 text-red-500">{msg()}</span>}
          </Show>
        </form>
      </Show>
    </div>
  );
}
