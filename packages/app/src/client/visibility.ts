/**
 * A reactive "is this tab worth doing work for" flag.
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
 * A `graceMs` debounce keeps a quick tab-switch (alt-tab to copy something,
 * glance at another app) from tearing down and re-subscribing the whole fleet:
 * the flag only drops to false once the tab has been hidden for `graceMs`. A
 * tab genuinely left in the background (the Task-Manager scenario) crosses that
 * and pauses.
 */

import { createSignal, onCleanup } from "solid-js";

export function createVisibilityGate(graceMs: number): () => boolean {
  // No document (tests / non-DOM) → always active; there's nothing to pause.
  if (typeof document === "undefined") return () => true;

  const visibleNow = () => document.visibilityState === "visible";
  const [active, setActive] = createSignal(visibleNow());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const onChange = () => {
    if (visibleNow()) {
      // Back in view — cancel any pending pause and resume immediately.
      clearTimer();
      setActive(true);
    } else if (timer === undefined) {
      // Hidden — pause only after the grace window, and only arm one timer.
      timer = setTimeout(() => {
        timer = undefined;
        setActive(false);
      }, graceMs);
    }
  };
  document.addEventListener("visibilitychange", onChange);
  onCleanup(() => {
    clearTimer();
    document.removeEventListener("visibilitychange", onChange);
  });
  return active;
}
