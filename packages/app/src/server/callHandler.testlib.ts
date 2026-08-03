/**
 * Test-only: call one bound member handler by its wire tag.
 *
 * The oRPC-era tests reached into `admin.router.surface.admin.hosts.<verb>`
 * and ran it through `@orpc/server`'s `call`. There is no router tree any
 * more — a served surface is a flat `{ group, handlers }` pair keyed by full
 * wire tag — so this is the successor: the same in-process invocation, one
 * layer lower, against the very record the transport dispatches through.
 *
 * The payload is the DECODED side (that is what a handler receives on every
 * path, wire or direct), and the returned `Effect` is run at this one edge.
 */

import type { SurfaceHandlers } from "@kolu/surface/server";
import { Effect } from "effect";

/** Invoke the unary handler at `tag`. Throws if nothing is bound there — an
 *  unbound tag is a wiring bug, never a runtime condition (`implementSurfaces`
 *  asserts its handler set equals its group's at boot). */
export function callHandler<O>(
  handlers: SurfaceHandlers,
  tag: string,
  payload: unknown,
): Promise<O> {
  const handler = handlers[tag];
  if (handler === undefined) {
    throw new Error(
      `callHandler: no handler bound at "${tag}" — bound tags: ${Object.keys(handlers).sort().join(", ")}`,
    );
  }
  return Effect.runPromise(
    handler(payload) as Effect.Effect<O, never, never>,
  );
}

/** The wire tag of an admin-surface procedure, spelled once. */
export function adminHostsTag(verb: string): string {
  return `surface/admin/hosts/${verb}`;
}
