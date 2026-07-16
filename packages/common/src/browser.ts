/**
 * App-only (browser + parent re-serve) surface bits. This is the ONLY
 * drishti-common module that imports `@kolu/surface-remote` — kept off the
 * agent-shared `./surface.ts` so the agent (whose scoped build hydrates only
 * `@kolu/surface`) never loads the parent-only provisioning lib at runtime.
 * Exposed as the `drishti-common/browser` subpath; the agent imports
 * `drishti-common` (`./surface.ts`) and never reaches this file.
 */

import { defineSurface, defineSurfaceWithPolicy } from "@kolu/surface/define";
import { z } from "zod";
import { MetricHistoryMessage, surface } from "./surface";

/** drishti's app-owned client-error-policy union (SR11, fork-A) — the OPAQUE,
 *  app-typed value the framework threads to the app's registered `onClientError`
 *  interpreter (`interpretClientError`, client `wire.ts`) but never reads. ONE arm:
 *  drishti LOGS (kolu, the other consumer, TOASTS the same seam — "the same member
 *  interpreted oppositely by two apps"). `label` carries the per-member console
 *  message so the ONE interpreter renders each member's line verbatim — the log twin
 *  of kolu's `{ kind: "toast"; label }` arm, and the divergent-app proof that the
 *  framework never names an app arm (drishti has no Toaster). */
export type ClientErrorPolicy = { kind: "log"; label: string };

/** The agent surface the parent serves, verbatim. SR9: no `connection` cell composed
 *  here — link health rides the host-map entry's fine `connection` payload (the ONE
 *  authority; see `hostMap.ts`'s `connection: ConnectionInfoSchema` + `admin-router.ts`'s
 *  `serveHostMap` `connection.project`), which the client derives the word from off the
 *  SAME entry it reads the dot. `metricHistory` is NOT here — it moved to parent-local
 *  policy (SR5), composed on via `extendSurface` (see app/server/router.ts). */
export const mirroredAgentSurface = surface;

/** The parent-LOCAL metric-history member — retention lives on the parent, not the
 *  agent (whose inert stub is gone, SR5). The parent serves it from its own runtime
 *  and composes it onto {@link mirroredAgentSurface} via `extendSurface`; declared
 *  HERE so BOTH the parent (serves it) and the browser (types off `browserSurface`)
 *  reference ONE declaration. */
export const historySurface = defineSurface({
  streams: {
    metricHistory: {
      inputSchema: z.object({}),
      outputSchema: MetricHistoryMessage,
    },
  },
});

/** The COMBINED surface the BROWSER consumes — the mirrored agent members PLUS the
 *  parent-local `metricHistory` — exactly what the parent's
 *  `extendSurface(mirroredAgentSurface, historyRuntime)` serves. The browser's client
 *  types off THIS, so it reaches every member the parent serves at the same flat
 *  paths, byte-identical. (A flat spec merge, mirroring `extendSurface`'s own merge.) */
export const browserSurface = defineSurfaceWithPolicy<ClientErrorPolicy>()({
  cells: {
    ...mirroredAgentSurface.spec.cells,
    // SR11 — the members whose client subscription failure the browser LOGS declare
    // their `{ kind: "log", label }` policy HERE (on the entry surface, the one the
    // client types off), so the failure routes to the ONE `interpretClientError` with
    // no per-use-site `onError`. `label` is the exact console message preserved.
    system: {
      ...mirroredAgentSurface.spec.cells.system,
      client: { onError: { kind: "log", label: "system subscription failed" } },
    },
    alerts: {
      ...mirroredAgentSurface.spec.cells.alerts,
      client: { onError: { kind: "log", label: "alerts subscription failed" } },
    },
  },
  collections: {
    ...mirroredAgentSurface.spec.collections,
    cpuCores: {
      ...mirroredAgentSurface.spec.collections.cpuCores,
      client: { onError: { kind: "log", label: "cpuCores subscription failed" } },
    },
    networkInterfaces: {
      ...mirroredAgentSurface.spec.collections.networkInterfaces,
      client: {
        onError: { kind: "log", label: "networkInterfaces subscription failed" },
      },
    },
  },
  procedures: mirroredAgentSurface.spec.procedures,
  streams: historySurface.spec.streams,
});

// The connection-cell types + gate-closed default, re-exported here (not from the
// agent-shared `./surface.ts`) so app modules import them without pulling
// `@kolu/surface-remote` into the agent's runtime.
export {
  type ConnectionInfo,
  DEFAULT_CONNECTION,
  type LogEntry,
} from "@kolu/surface-remote/connection";
import type { ConnectionInfo } from "@kolu/surface-remote/connection";

// kolu W6 reshaped the connection cell into ONE discriminated union on `phase` and
// deleted the standalone `ConnectionState`/`FailureCause` names. Re-derive them
// locally so drishti's presentation code (the `STATE` map, `disconnectedMessage`)
// keeps a name for each — BOTH from the one source of truth, never hand-listed: the
// phase set is the union's discriminant, and the failure cause is the `disconnected`
// down arm's `cause` (so a change to kolu's cause vocabulary flows here automatically).
export type ConnectionState = ConnectionInfo["phase"];
export type FailureCause = Extract<
  ConnectionInfo,
  { phase: "disconnected" }
>["cause"];
