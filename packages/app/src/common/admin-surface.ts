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
 * Served at `/rpc/ws?host=__admin__` — the reserved sentinel
 * (`ADMIN_HOST_SENTINEL`, defined in `./host`) and the upgrade handler in
 * `server/main.ts`.
 *
 * The admin connection is also drishti's CONTROL PLANE: the one
 * always-open, global connection. surface-app's build-identity surface
 * (the `buildInfo` cell + the `identity.info` restart probe) rides this
 * same transport — but as a SIBLING surface, NOT merged into the admin
 * surface (kolu#1197/#1201). `composeSurfaceContracts` multiplexes the
 * two: drishti's own `admin` surface under the `admin` key, surface-app's
 * complete surface under the `surfaceApp` key. Each is namespaced by its
 * key on the wire (`/surface/admin/…` vs `/surface/surfaceApp/…`).
 */

import { composeSurfaceContracts, defineSurface } from "@kolu/surface/define";
import type { SurfaceTypes } from "@kolu/surface/define";
import { surfaceAppSurface } from "@kolu/surface-app/surface";
import { z } from "zod";
import { isValidHost } from "./host";

const HostEntrySchema = z.object({
  host: z.string().min(1),
});

const HostInputSchema = z
  .string()
  .refine(
    isValidHost,
    "host must be non-empty, have no whitespace, not start with '-', and not be the admin sentinel",
  );

/** drishti's OWN admin surface — just the host set + the host-lifecycle
 *  procedures. surface-app's buildInfo/identity ride the sibling surface,
 *  not here. */
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
});

/** surface-app served as a SIBLING of the admin surface — drishti uses the
 *  DEFAULT build identity (`{ commit }`), so it takes the library's
 *  `surfaceAppSurface` directly (no `surfaceAppSurfaceWith`). Re-exported so
 *  the server (`implementSurfaces`) and client (`surfaceClients`) bind the
 *  same surface instance. */
export { surfaceAppSurface };

/** The two siblings, keyed. Both server and client iterate this same map,
 *  so the keys can't drift. */
export const adminSurfaces = {
  admin: adminSurface,
  surfaceApp: surfaceAppSurface,
} as const;

/** Combined wire contract for the admin transport — `{ surface: { admin,
 *  surfaceApp } }`. The server wraps `implementSurfaces`' router with
 *  `implement(adminContract).router(...)`; the client types its
 *  `websocketLink` off `typeof adminContract`. */
export const adminContract = composeSurfaceContracts(adminSurfaces);

type AS = SurfaceTypes<typeof adminSurface.spec>;
export type HostEntry = AS["collections"]["hosts"]["Value"];
