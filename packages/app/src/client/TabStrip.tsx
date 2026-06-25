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

import { useSurfaceApp } from "@kolu/surface-app/solid";
import { createPwaInstall, installInstructions } from "@kolu/solid-pwa-install";
import { createMemo, createSignal, For, Show } from "solid-js";
import { type ConnectionState, DEFAULT_CONNECTION } from "drishti-common/browser";
import type { View } from "./view";
import { STATE } from "./connectionColors";
import { otherTheme, type Theme } from "./theme";
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
  theme: Theme;
  onToggleTheme: () => void;
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
      <PinAppButton />
      <ThemeToggle theme={props.theme} onToggle={props.onToggleTheme} />
    </div>
  );
}

// "Pin app" — drishti's install affordance, the second consumer of
// `@kolu/surface-app`'s installability signals (mirroring how kolu wires its own
// EmptyState install card). The gate is exactly the one the kolu welcome plan
// documents:
//
//   1. NOT a secure context (plain http://, e.g. a bare `100.x` Tailscale IP)
//      → render nothing (`canInstallPwa()` is false): no one-click prompt is
//      possible there, so a button would be a dead control.
//   2. ALREADY installed (standalone display-mode / iOS `navigator.standalone`)
//      → render nothing. Nothing left to pin.
//   3. secure + not installed → show the button. On Chromium a click fires the
//      one-click `prompt()`; elsewhere (Safari/Firefox/iOS — no JS prompt) it
//      reveals the auto-detected per-platform `installInstructions` inline.
//
// `canInstallPwa` (isSecureContext) and `isInstalled` (display-mode) are signals
// on `useSurfaceApp()`; `createPwaInstall` / `installInstructions` come from
// `@kolu/solid-pwa-install`. surface-app owns the signals because secure-context
// + install state are an environment fact every surface app needs; solid-pwa-
// install owns the cross-browser install volatility behind one socket.
function PinAppButton() {
  const app = useSurfaceApp();
  const install = createPwaInstall();
  const [open, setOpen] = createSignal(false);
  const show = () => app.canInstallPwa() && !app.isInstalled();
  const instr = () => installInstructions(install.platform());

  return (
    <Show when={show()}>
      <div class="relative self-center">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
          title="Install drishti as an app on this device"
          aria-expanded={open()}
          onClick={() => {
            // Chromium: the one-click native prompt. Otherwise toggle the inline
            // per-platform steps (the package owns the recipe).
            if (install.canPrompt()) install.prompt();
            else setOpen((v) => !v);
          }}
        >
          <span aria-hidden="true">⤓</span>
          Pin app
        </button>
        <Show when={open() && !install.canPrompt()}>
          <div class="absolute right-0 top-full z-10 mt-1 w-60 rounded-lg border border-zinc-200 bg-white p-3 text-xs text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            <div class="mb-1 font-semibold">{instr().title}</div>
            <ol class="ml-4 list-decimal space-y-0.5">
              <For each={instr().steps}>{(s) => <li>{s}</li>}</For>
            </ol>
          </div>
        </Show>
      </div>
    </Show>
  );
}

// Light/dark switch. Owns the row's single `ml-auto`, which absorbs all free
// space and pins it to the right edge of the strip. Shows the icon of the
// theme it will switch *to*: a moon while light, a sun while dark.
function ThemeToggle(props: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      type="button"
      class="ml-auto flex items-center px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800/60"
      title={`Switch to ${otherTheme(props.theme)} theme`}
      aria-label={`Switch to ${otherTheme(props.theme)} theme`}
      onClick={props.onToggle}
    >
      <span aria-hidden="true">{props.theme === "dark" ? "☀" : "☾"}</span>
    </button>
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
          class={`inline-block h-2 w-2 rounded-full ${STATE[state()].dotBg} ${STATE[state()].pending ? "animate-pulse" : ""}`}
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
