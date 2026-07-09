/**
 * App-only (browser + parent re-serve) surface bits. This is the ONLY
 * drishti-common module that imports `@kolu/surface-remote` — kept off the
 * agent-shared `./surface.ts` so the agent (whose scoped build hydrates only
 * `@kolu/surface`) never loads the parent-only provisioning lib at runtime.
 * Exposed as the `drishti-common/browser` subpath; the agent imports
 * `drishti-common` (`./surface.ts`) and never reaches this file.
 */

import { mirroredSurface } from "@kolu/surface-remote/connection";
import { surface } from "./surface";

/** The surface the BROWSER consumes and the PARENT re-serves: the agent's base
 *  `surface` augmented at the mirror seam with the gate-closed get-only
 *  `connection` cell. The agent serves the base; the parent mirrors it and writes
 *  `connection` from `session.onState` — kolu's `mirroredSurface` combinator, the
 *  single source of truth, instead of a hand-composed cell. */
export const browserSurface = mirroredSurface(surface);

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
// keeps a name for each: the phase set is the union's discriminant, and the failure
// cause is the down arms' `"network" | "remote"`.
export type ConnectionState = ConnectionInfo["phase"];
export type FailureCause = "network" | "remote";
