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

import { isCleanRef } from "@kolu/surface-app";
import { type ConnectionStatus, useSurfaceApp } from "@kolu/surface-app/solid";
// TODO(pin): the install-card adapter. This package is scaffolded on the kolu
// `welcome` branch but its `src/index.tsx` is not implemented yet, and that
// branch is not on a pinned/published kolu revision — so this import does not
// resolve against the current `npins/sources.json` kolu pin. Bump the kolu pin
// to the merged `welcome` revision (which ships `@kolu/solid-pwa-install`'s
// source + adds `canInstallPwa` / `isInstalled` to `useSurfaceApp()`), then drop
// the `PWA_INSTALL_WIRED` guard below. The nix wiring (overlay/env/shell/justfile/
// build derivation) to hydrate this package into node_modules is already in place.
//
// import { PwaInstall } from "@kolu/solid-pwa-install";
import { createMemo, createSignal, For, Show } from "solid-js";
import { type ConnectionState, DEFAULT_CONNECTION } from "drishti-common";
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
      <IdentityRail />
      <ThemeToggle theme={props.theme} onToggle={props.onToggleTheme} />
    </div>
  );
}

// Always-on identity rail — the same `srv · client` readout kolu carries in its
// ChromeBar (`packages/client/src/ui/IdentityRail.tsx`), ported here with
// drishti's tailwind palette. `srv` is the control-plane connection: a liveness
// dot (from surface-app's headless `status()`) plus the server's build commit;
// `client` is the commit this browser's bundle was baked from, flagging `≠ srv`
// (one-tap reload) when the two clean refs provably disagree. Distinct from the
// per-host SSH `connection` dots on the chips. `ml-auto` right-aligns it next to
// the theme toggle; unlike the old skew-only badge, it is ALWAYS visible.
const SRV_DOT: Record<ConnectionStatus, string> = {
  live: "bg-emerald-500",
  reconnecting: "bg-amber-500 animate-pulse",
  restarted: "bg-amber-500 animate-pulse",
  down: "bg-red-500",
};

function IdentityRail() {
  const pwa = useSurfaceApp();
  return (
    <div class="ml-auto mr-1 inline-flex items-stretch self-center rounded-lg border border-gray-200 bg-gray-100/60 p-0.5 font-mono text-xs dark:border-gray-700 dark:bg-gray-800/60">
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5">
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
      <span class="mx-0.5 h-4 w-px self-center bg-gray-300 dark:bg-gray-600" />
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5">
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
            class="self-center rounded-full border border-amber-400/50 px-1.5 text-[9px] leading-4 text-amber-600 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/30"
          >
            ≠ srv
          </button>
        </Show>
      </span>
    </div>
  );
}

// Whether the install-card adapter is wired (see the TODO(pin) on the import at
// the top of this file). Flipped to `true` in the same change that bumps the
// kolu pin and uncomments the `@kolu/solid-pwa-install` import — until then the
// button stays off so an unwired build still runs. This guard is the ONLY thing
// that should change when the kolu PR lands; the gate logic below is final.
const PWA_INSTALL_WIRED = false;

// "Pin app" — drishti's install affordance, the second consumer of
// `@kolu/surface-app`'s new installability signals (mirroring how kolu wires its
// own EmptyState install card). The gate is exactly the one the kolu welcome plan
// documents:
//
//   1. NOT a secure context (plain http://, e.g. a bare `100.x` Tailscale IP)
//      → render nothing. `beforeinstallprompt` never fires there and Chromium
//      shows no install affordance, so a button would be a dead control.
//   2. ALREADY installed (standalone display-mode / iOS `navigator.standalone`)
//      → render nothing. Nothing left to pin.
//   3. secure + not installed → show the button; clicking opens the
//      `@kolu/solid-pwa-install` card, which owns the cross-browser volatility
//      (Chromium one-click `prompt()`, Safari/iOS "Add to Home Screen"
//      instructions, the `appinstalled` listener).
//
// `canInstallPwa` (isSecureContext) and `isInstalled` (display-mode) are the new
// signals on `useSurfaceApp()` from the kolu welcome PR. surface-app owns them
// because secure-context + install state are an environment fact every surface
// app needs, not a drishti concern.
function PinAppButton() {
  const app = useSurfaceApp();
  // The card's open state. Read into the trigger's `aria-expanded` so it's a live
  // value now (not just a TODO), and consumed by the `<PwaInstall>` `open` prop
  // once that import lands — see the gated block below.
  const [open, setOpen] = createSignal(false);

  // TODO(pin): once the kolu pin ships the new signals, these read straight off
  // the model: `const show = () => app.canInstallPwa() && !app.isInstalled();`.
  // Until then the model has neither accessor, so the button is held off by the
  // wiring guard rather than the (not-yet-present) runtime signals — keeping an
  // unwired build type-clean and runnable.
  const show = () =>
    PWA_INSTALL_WIRED &&
    // @ts-expect-error TODO(pin): canInstallPwa/isInstalled arrive on the model
    // with the kolu welcome PR; typed-checked once the pin is bumped.
    app.canInstallPwa?.() === true &&
    // @ts-expect-error see above.
    app.isInstalled?.() !== true;

  return (
    <Show when={show()}>
      <button
        type="button"
        class="flex items-center gap-1.5 self-center rounded-lg border border-indigo-300 bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
        title="Install drishti as an app on this device"
        aria-expanded={open()}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">⤓</span>
        Pin app
      </button>
      {/*
        TODO(pin): render the install card once `@kolu/solid-pwa-install` resolves.
        The card owns the per-platform branch; drishti only feeds branding +
        controls open state:

          <PwaInstall
            open={open()}
            onClose={() => setOpen(false)}
            manifest-url="/manifest.webmanifest"
            icon="/icons/icon-192.png"
            install-description="htop for your whole fleet — pin it for one-tap access."
          />

        `open()` is wired now so the trigger half is real and reviewable; only the
        card import is gated. */}
    </Show>
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

// Light/dark switch. Right-alignment is a consequence of following IdentityRail
// in the flex row — IdentityRail owns the row's single `ml-auto`, which absorbs
// all free space, so this button needs none of its own. Shows the icon of the
// theme it will switch *to*: a moon while light, a sun while dark.
function ThemeToggle(props: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      type="button"
      class="flex items-center px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800/60"
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
