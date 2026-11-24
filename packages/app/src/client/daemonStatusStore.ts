/**
 * Single-writer fleet daemon-status poll (U2.2).
 *
 * MultiHostApp owns one poll for ALL hosts; TabChip / HostCard / HostView
 * read the same map — no second polling authority per selected host.
 */
import {
  createContext,
  createEffect,
  createSignal,
  useContext,
  type Accessor,
  type Setter,
} from "solid-js";
import type { DaemonStatus } from "../common/daemonStatus";
import {
  applyDaemonStatusError,
  applyDaemonStatusOk,
  applyRenewResult,
  applyRenewStart,
  type RenewUiState,
} from "./daemonStatusPresentation";
import { adminRpc, runCall } from "./wire";

export type DaemonStatusMap = Readonly<Record<string, DaemonStatus | null>>;
export type RenewStateMap = Readonly<Record<string, RenewUiState>>;

export type DaemonStatusStore = {
  byHost: Accessor<DaemonStatusMap>;
  pollErrorByHost: Accessor<Readonly<Record<string, string | null>>>;
  renewByHost: Accessor<RenewStateMap>;
  dialogHost: Accessor<string | null>;
  setDialogHost: Setter<string | null>;
  pollHost: (host: string) => void;
  pollAll: (hosts: readonly string[]) => void;
  renew: (host: string) => void;
  reconnect: (host: string) => void;
};

const DaemonStatusCtx = createContext<DaemonStatusStore>();

// `DaemonStatusCtx` has no default, so a chip/dialog drawn outside
// `MultiHostApp`'s provider throws on its own (`ContextNotFoundError`) and
// `useContext` returns the store, never `undefined`.
export function useDaemonStatusStore(): DaemonStatusStore {
  return useContext(DaemonStatusCtx);
}

export { DaemonStatusCtx };

/** Create the store (call once in MultiHostApp). */
export function createDaemonStatusStore(): DaemonStatusStore {
  const [byHost, setByHost] = createSignal<DaemonStatusMap>({});
  const [pollErrorByHost, setPollErrorByHost] = createSignal<
    Readonly<Record<string, string | null>>
  >({});
  const [renewByHost, setRenewByHost] = createSignal<RenewStateMap>({});
  const [dialogHost, setDialogHost] = createSignal<string | null>(null);

  const pollHost = (host: string) => {
    void runCall(adminRpc().hosts.daemonStatus({ host }))
      .then((r) => {
        const folded = applyDaemonStatusOk(r);
        setByHost((prev) => ({ ...prev, [host]: folded.status }));
        setPollErrorByHost((prev) => ({ ...prev, [host]: null }));
      })
      .catch((err) => {
        const msg = (err as Error).message;
        const prevStatus = byHost()[host] ?? null;
        const folded = applyDaemonStatusError(prevStatus, msg);
        setByHost((prev) => ({ ...prev, [host]: folded.status }));
        setPollErrorByHost((prev) => ({ ...prev, [host]: folded.pollError }));
      });
  };

  const pollAll = (hosts: readonly string[]) => {
    for (const h of hosts) pollHost(h);
  };

  const renew = (host: string) => {
    setRenewByHost((prev) => ({
      ...prev,
      [host]: applyRenewStart(prev[host] ?? { kind: "idle" }),
    }));
    void runCall(adminRpc().hosts.renew({ host }))
      .then((r) => {
        setRenewByHost((prev) => ({
          ...prev,
          [host]: applyRenewResult(r),
        }));
        pollHost(host);
      })
      .catch((err) => {
        setRenewByHost((prev) => ({
          ...prev,
          [host]: applyRenewResult({
            ok: false,
            error: (err as Error).message,
          }),
        }));
      });
  };

  const reconnect = (host: string) => {
    void runCall(adminRpc().hosts.reconnect({ host }))
      .then(() => pollHost(host))
      .catch((err) => console.error(`reconnect ${host} failed`, err));
  };

  return {
    byHost,
    pollErrorByHost,
    renewByHost,
    dialogHost,
    setDialogHost,
    pollHost,
    pollAll,
    renew,
    reconnect,
  };
}

/** Start the fleet poll under the caller's owner; it stops with that owner. */
export function startDaemonStatusPoll(
  store: DaemonStatusStore,
  hosts: Accessor<readonly string[]>,
  intervalMs = 5_000,
): void {
  // The membership read lives in the compute, so the first poll fires from the
  // effect phase rather than the caller's component body (where reading `hosts()`
  // is a strict read and the poll's writes are writes in an owned scope). A
  // membership change re-runs it: the new fleet is polled at once instead of up
  // to `intervalMs` later, and the returned cleanup clears the previous interval
  // — the same teardown the `onCleanup` here used to do, now on the effect's own
  // schedule.
  createEffect(hosts, (list) => {
    store.pollAll(list);
    const iv = setInterval(() => store.pollAll(list), intervalMs);
    return () => clearInterval(iv);
  });
}
