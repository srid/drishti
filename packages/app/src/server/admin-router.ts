/**
 * Admin-surface router.
 *
 * Owns the parent's view of "which hosts exist". The `hosts` collection
 * projects from the supplied `HostRegistry` — there is no shadow cache,
 * so admin and registry cannot diverge by construction.
 *
 * `hosts.add` / `hosts.remove` procedures hand off to the registry for
 * the side effects (spawn/destroy session+handler, persist to disk,
 * close any dangling browser WSes pointed at the removed host). The
 * channel publish that notifies subscribers fires AFTER the registry
 * mutation resolves — so a browser subscribing to a newly-added host
 * always lands on a live handler, and a subscriber learning about a
 * removed host never sees the upgrade handler still routing to it.
 */

import { implement } from "@orpc/server";
import {
  implementSurface,
  inMemoryChannelByName,
} from "@kolu/surface/server";
import {
  ADMIN_HOST_SENTINEL,
  adminSurface,
} from "../common/admin-surface";
import type { HostRegistry } from "./hostRegistry";

export interface AdminRouterOptions {
  registry: HostRegistry;
}

export function buildAdminRouter(opts: AdminRouterOptions) {
  const fragment = implementSurface(adminSurface, {
    channel: inMemoryChannelByName(),
    collections: {
      hosts: {
        // Live projection from the registry — the framework calls this
        // for every new subscriber's first frame.
        readAll: () => opts.registry.snapshot(),
        // No-op deps. The procedures below mutate the registry directly
        // and then call `fragment.ctx.collections.hosts.upsert/remove`
        // to publish the change; the framework's channel publish fires
        // off these calls regardless of what the deps do. Keeping the
        // deps empty avoids maintaining a parallel cache that could
        // drift from the registry.
        upsert: () => {},
        remove: () => {},
      },
    },
    procedures: {
      hosts: {
        add: async ({ input }) => {
          const host = input.host.trim();
          if (host === ADMIN_HOST_SENTINEL) {
            return { ok: false, error: "host name reserved" };
          }
          if (opts.registry.has(host)) {
            return { ok: false, error: "host already exists" };
          }
          try {
            // Invariant: `registry.add` must resolve BEFORE the channel
            // publish below. The publish synchronously triggers each
            // subscribed browser to open a new WS for the host; if the
            // handler isn't built yet, the upgrade handler rejects.
            await opts.registry.add(host);
          } catch (err) {
            return { ok: false, error: (err as Error).message };
          }
          fragment.ctx.collections.hosts.upsert(host, { host });
          return { ok: true };
        },
        remove: async ({ input }) => {
          if (!opts.registry.has(input.host)) return { ok: false };
          try {
            // Invariant: `registry.remove` must resolve BEFORE the
            // channel publish below. The registry closes the host's
            // open WSes and destroys the session synchronously; only
            // then is the subscriber notified the host has gone.
            await opts.registry.remove(input.host);
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
