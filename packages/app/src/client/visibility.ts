/**
 * Grace-gate a reactive page-visibility flag.
 *
 * drishti's telemetry is SERVER-pushed: a hidden tab keeps receiving every 2s
 * frame and running the full decode → reconcile → memo cascade. Browsers
 * throttle paint and most timers for a background tab, but NOT WebSocket
 * delivery — so without a gate a backgrounded fleet burns the same CPU as a
 * foregrounded one, for data nobody can see. The caller unmounts the data views
 * on this flag, which tears down the per-host subscriptions; the sockets stay
 * warm (the `wire.ts` host cache), so becoming visible re-subscribes and the
 * parent re-seeds each ring's snapshot — history is intact on return.
 *
 * The two bounded leaves are LIBRARY code, not hand-rolled: page-visibility
 * DETECTION comes from `@solid-primitives/page-visibility` (the single
 * `visibilitychange` subscription, SSR-safe) and the grace window from
 * `@solid-primitives/scheduled`'s trailing `debounce`. Only the asymmetric
 * policy is ours — resume IMMEDIATELY on becoming visible, pause only after the
 * tab has been hidden for `graceMs` (so a quick alt-tab to copy something
 * doesn't tear down and re-subscribe the whole fleet; a tab genuinely left in
 * the background — the Task-Manager scenario — crosses the window and pauses).
 *
 * Takes the `visible` accessor rather than creating its own so the caller sources
 * page-visibility ONCE and feeds every consumer (this gate AND the becoming-
 * visible link re-probe) from one subscription — no parallel listener to drift.
 */

import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { debounce } from "@solid-primitives/scheduled";

export function createVisibilityGate(
  visible: () => boolean,
  graceMs: number,
): () => boolean {
  const [active, setActive] = createSignal(visible());
  const pauseSoon = debounce(() => setActive(false), graceMs);
  // `defer` so the initial value (already seeded into `active`) doesn't schedule
  // a redundant pause; react only to genuine visibility CHANGES.
  createEffect(
    on(
      visible,
      (v) => {
        if (v) {
          pauseSoon.clear(); // back in view — cancel a pending pause, resume now
          setActive(true);
        } else {
          pauseSoon(); // hidden — pause only once the grace window elapses
        }
      },
      { defer: true },
    ),
  );
  onCleanup(() => pauseSoon.clear());
  return active;
}
