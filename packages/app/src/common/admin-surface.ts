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

export const adminSurface = defineSurface({
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
    },
  },
});

type AS = SurfaceTypes<typeof adminSurface.spec>;
export type HostEntry = AS["collections"]["hosts"]["Value"];
