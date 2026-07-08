/**
 * The keyed HOST MAP — ONE entry surface (`browserSurface`, drishti's
 * per-host parent↔agent bridge surface) served N times, keyed by host
 * string. This is the `@kolu/surface-map` framework notion
 * (`defineSurfaceMap`) that REPLACES drishti's hand-rolled per-host
 * WebSocket + `RPCHandler` dispatch (`hostRegistry.ts`'s old `getHandler` /
 * `?host=` upgrade routing) and `admin-surface.ts`'s hand-rolled `hosts`
 * collection: host membership + connection status (`EntryStatus`) are now
 * the map's OWN `entries` collection, published for free by
 * `serveHostMap`/`connectSurfaceMap` — the same unification kolu's own
 * host switch adopted.
 *
 * Every host's traffic rides ONE shared transport now (the admin socket),
 * folded through the map's `{ mapKey, input }` wire envelope — not a
 * dedicated `?host=` socket per host. `admin-router.ts` serves this map
 * (`serveHostMap`) over the warm host pool `hostRegistry.ts` owns;
 * `wire.ts` dials it (`connectSurfaceMap`) as the `"hosts"` sibling key on
 * the admin transport's branded handle.
 */

import { defineSurfaceMap, type KeyCodec } from "@kolu/surface-map";
import { browserSurface } from "drishti-common/browser";
import { z } from "zod";

/** A host is already the canonical wire string — unlike kolu's
 *  discriminated-sum `HostKey`, there is no richer key shape to brand. */
export const HostKeySchema = z.string();

/** The identity codec: `Key` (a plain host string) IS already the wire
 *  string every channel name / dedup key / membership entry is keyed on,
 *  so encode/decode are both the identity function. */
const hostKeyCodec: KeyCodec<string> = {
  encode: (k) => k,
  decode: (s) => s,
};

/** The map of every configured host's `browserSurface`. Server
 *  (`serveHostMap`, in `admin-router.ts`) and client (`connectSurfaceMap`,
 *  in `wire.ts`) share this ONE definition, so the two sides can't drift. */
export const hostSurfaceMap = defineSurfaceMap(
  HostKeySchema,
  browserSurface,
  hostKeyCodec,
);
