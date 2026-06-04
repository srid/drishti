/**
 * Admin surface — the *set* of hosts.
 *
 * Volatility-distinct from the per-host `surface` (system / processes /
 * cpuCores / connection): admin mutates on user action (add/remove)
 * rather than per poll tick. Keeping it on its own surface lets the
 * per-host schema stay scalar (no host-keyed primitives) and lets admin
 * grow procedures (auth, alerts, renaming) without churning the data
 * primitives.
 *
 * Served at `/rpc/ws?host=__admin__` — the reserved sentinel; see
 * `ADMIN_HOST_SENTINEL` below and the upgrade handler in
 * `server/main.ts`.
 */

import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import { composeSurfaces, surfaceAppSurface } from "@kolu/surface-app/surface";
import { z } from "zod";

/** Reserved string used as the `host=` query value for the admin
 *  surface. Rejected by `addHost` validation so it can't collide with a
 *  real host name. */
export const ADMIN_HOST_SENTINEL = "__admin__";

const HostEntrySchema = z.object({
  host: z.string().min(1),
});

const HostInputSchema = z
  .string()
  .min(1)
  .refine(
    (s) => s !== ADMIN_HOST_SENTINEL && !/\s/.test(s),
    "host must be non-empty, have no whitespace, and not be the admin sentinel",
  );

// surface-app-specific — the global build identity (`buildInfo` cell) and the
// `surfaceApp.info` restart probe, merged in one call. The admin surface is
// drishti's CONTROL PLANE: the one always-open, global connection (the per-host
// surfaces are per-entity), so global build skew + the restart probe belong
// here, not on a host surface. surface-app reads `processId` on each (re)connect
// to tell a transient drop from a parent restart (drives the control-plane
// status). drishti uses the DEFAULT build identity (`{ commit }`), so it merges
// `surfaceAppSurface` directly — no `surfaceAppSurfaceWith`.
export const adminSurface = defineSurface(
  composeSurfaces(surfaceAppSurface, {
    collections: {
      /** Configured hosts. Key = host string (ssh target). The browser's
       *  tab strip subscribes to this collection — adds/removes ripple
       *  through `useCollection` and the strip updates without polling. */
      hosts: {
        keySchema: z.string(),
        schema: HostEntrySchema,
      },
    },
    procedures: {
      hosts: {
        add: {
          input: z.object({ host: HostInputSchema }),
          output: z.object({ ok: z.boolean(), error: z.string().optional() }),
        },
        remove: {
          input: z.object({ host: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
        // Re-arm a host whose parent session gave up (its `connection`
        // cell is `failed`). Distinct from add/remove: it mutates session
        // lifecycle, not host-set membership — the host stays configured,
        // so this never touches the `hosts` collection. The recovery flows
        // back through the per-host `connection` cell, not here.
        reconnect: {
          input: z.object({ host: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
        // Force a fresh link probe on every host — the browser fires this on
        // regaining connectivity (`online`) or refocus (`visibilitychange`),
        // the client-side companion to the parent's own wake monitor. No
        // input (it's fleet-wide) and no host-set change; like `reconnect`,
        // recovery is observed via each host's `connection` cell.
        recheck: {
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
        },
      },
    },
  }),
);

type AS = SurfaceTypes<typeof adminSurface.spec>;
export type HostEntry = AS["collections"]["hosts"]["Value"];
