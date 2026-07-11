/**
 * Client-observed alert raise-time bookkeeping — pure, framework-free.
 *
 * The `alerts` wire carries LEVEL state only: a bare set of currently-raised
 * ids, no history (the ratified design). So the only honest "since when" the
 * host-detail panel can show is when THIS session first saw an alert raised.
 * `reconcileRaiseTimes` folds the live raised-key set forward against the
 * previously-stamped map: a newly-present key gets `now`; a key that has left
 * the set (the metric fell below the hysteresis CLEAR threshold, so the agent
 * dropped it) is forgotten, so a later RE-raise stamps a fresh time rather than
 * resurrecting a stale one. It lives here — not inline in the App effect that
 * drives it — precisely so the raise/clear/re-raise behaviour is unit-provable
 * without standing up a DOM, which is how we prove "the alert (and its badge)
 * clears on hysteresis release" end-to-end rather than assuming it.
 *
 * Returns the SAME `prev` reference when nothing changed, so the caller's
 * signal write is skipped and no redundant re-render fires.
 */
export function reconcileRaiseTimes(
  prev: Record<string, number>,
  live: ReadonlySet<string>,
  now: number,
): Record<string, number> {
  let next = prev;
  // Stamp keys that are newly raised (present in `live`, unseen in the map).
  for (const key of live)
    if (!(key in next)) {
      if (next === prev) next = { ...prev };
      next[key] = now;
    }
  // Forget keys that have cleared (stamped, but no longer live) so a re-raise
  // is stamped fresh — never with the previous raise's time.
  for (const key of Object.keys(next))
    if (!live.has(key)) {
      if (next === prev) next = { ...prev };
      delete next[key];
    }
  return next;
}
