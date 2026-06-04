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
import { inMemoryChannelByName } from "@kolu/surface/server";
import {
  implementSurfaceApp,
  surfaceAppServer,
} from "@kolu/surface-app/server";
import { adminSurface } from "../common/admin-surface";
import type { HostRegistry } from "./hostRegistry";
import { makeLogger } from "./log";

const log = makeLogger("admin");

export interface AdminRouterOptions {
  registry: HostRegistry;
}

export function buildAdminRouter(opts: AdminRouterOptions) {
  // The whole surface-app server side composed in one call: `surfaceAppServer()`
  // supplies both halves of the fragment — the build-identity cell store (commit
  // resolved once: SURFACE_APP_COMMIT env → git → "dev"; the same commit is baked
  // into the client bundle via build.ts's Bun.build define, so client and server
  // stamp one value and skew is detectable across deploys) AND the `surfaceApp.info`
  // identity probe impl (one processId per process, minted by the library — restart
  // the parent → new id → the control-plane status flips to "restarted").
  // `implementSurfaceApp` merges both into our own deps, runs `implementSurface`,
  // and owns the buildInfo connect — so we pass ONLY drishti's own collections and
  // host procedures.
  const { router: fragmentRouter, ctx } = implementSurfaceApp(
    adminSurface,
    surfaceAppServer(),
    {
      channel: inMemoryChannelByName(),
      collections: {
        hosts: {
          // Live projection from the registry — the framework calls this
          // for every new subscriber's first frame.
          readAll: () => opts.registry.snapshot(),
          // No-op deps. The procedures below mutate the registry directly
          // and then call `ctx.collections.hosts.upsert/remove` to publish
          // the change; the framework's channel publish fires off these calls
          // regardless of what the deps do. Keeping the deps empty avoids
          // maintaining a parallel cache that could drift from the registry.
          upsert: () => {},
          remove: () => {},
        },
      },
      procedures: {
        hosts: {
          add: async ({ input }) => {
            // `HostInputSchema` already rejects blank, whitespace-containing,
            // and sentinel strings at validation time; no re-check needed here.
            const host = input.host.trim();
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
            ctx.collections.hosts.upsert(host, { host });
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
              log(`remove ${input.host} failed: ${(err as Error).message}`);
              return { ok: false };
            }
            ctx.collections.hosts.remove(input.host);
            return { ok: true };
          },
          reconnect: ({ input }) => {
            // No `hosts` collection publish: membership is unchanged. The
            // session's copying→connecting→connected transition streams
            // back through the per-host `connection` cell on its own.
            if (!opts.registry.has(input.host)) return { ok: false };
            opts.registry.reconnect(input.host);
            return { ok: true };
          },
          recheck: () => {
            // Fleet-wide force-reprobe (browser regained connectivity /
            // refocused). Like `reconnect`, no membership change and no
            // collection publish — each host's recovery streams back through
            // its own `connection` cell.
            opts.registry.recheckAll();
            return { ok: true };
          },
        },
      },
    },
  );

  const router = implement(adminSurface.contract).router({
    ...fragmentRouter,
  });
  return { router };
}
