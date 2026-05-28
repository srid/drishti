/**
 * Admin-surface router.
 *
 * Owns the parent's view of "which hosts exist". The `hosts` collection
 * publishes the set; `hosts.add` / `hosts.remove` procedures hand off to
 * caller-supplied `onAdd` / `onRemove` callbacks for the side effects
 * (create/destroy per-host session+handler, persist to disk, close any
 * dangling browser WSes pointed at the removed host).
 *
 * The router is the *single writer* on `hosts`. Boot seeds the
 * collection with `initialHosts`; everything thereafter flows through
 * the procedures.
 */

import { implement } from "@orpc/server";
import {
  implementSurface,
  inMemoryChannelByName,
} from "@kolu/surface/server";
import {
  ADMIN_HOST_SENTINEL,
  adminSurface,
  type HostEntry,
} from "../common/admin-surface";

export interface AdminRouterOptions {
  initialHosts: readonly string[];
  /** Side-effect: create the per-host session+handler, persist. Throws
   *  to fail the procedure (the rejection's message becomes `error`). */
  onAdd: (host: string) => Promise<void>;
  /** Side-effect: destroy the per-host session, close any open browser
   *  WSes for the host, persist. Resolves even if the host wasn't known
   *  (defensive — the procedure already filters). */
  onRemove: (host: string) => Promise<void>;
}

export function buildAdminRouter(opts: AdminRouterOptions) {
  const cache = new Map<string, HostEntry>();
  for (const host of opts.initialHosts) cache.set(host, { host });

  const fragment = implementSurface(adminSurface, {
    channel: inMemoryChannelByName(),
    collections: {
      hosts: {
        readAll: () => cache,
        upsert: (k, v) => {
          cache.set(k, v);
        },
        remove: (k) => {
          cache.delete(k);
        },
      },
    },
    procedures: {
      hosts: {
        add: async ({ input }) => {
          const host = input.host.trim();
          if (host === ADMIN_HOST_SENTINEL) {
            return { ok: false, error: "host name reserved" };
          }
          if (cache.has(host)) {
            return { ok: false, error: "host already exists" };
          }
          try {
            await opts.onAdd(host);
          } catch (err) {
            return { ok: false, error: (err as Error).message };
          }
          fragment.ctx.collections.hosts.upsert(host, { host });
          return { ok: true };
        },
        remove: async ({ input }) => {
          if (!cache.has(input.host)) return { ok: false };
          try {
            await opts.onRemove(input.host);
          } catch (err) {
            process.stderr.write(
              `[admin] remove ${input.host} failed: ${(err as Error).message}\n`,
            );
            return { ok: false };
          }
          fragment.ctx.collections.hosts.remove(input.host);
          return { ok: true };
        },
      },
    },
  });

  const router = implement(adminSurface.contract).router({
    ...fragment.router,
  });
  return { router };
}
