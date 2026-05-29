/**
 * Per-host UI preferences persisted to browser `localStorage`.
 *
 * The same shape as {@link ./urlState}: the signal in the component is the
 * source of truth, the store is its projection. The pure pieces — the
 * namespaced key and the validated read — live here; the `createSignal`
 * seed and the `createEffect` that writes on change stay in `HostView`,
 * exactly as `urlState`'s (de)serializers stay separate from the
 * `history.replaceState` effect in `App`.
 *
 * Why `localStorage` and not the URL (which already carries the selected
 * host): the URL is *shareable* state — a link you hand someone resolves
 * to the same host. Window/sort/filter are *private* reading conveniences;
 * putting them in the URL would be noise in a shared link. Different
 * concept, different store — so this is its own module, not an extension
 * of `urlState`.
 *
 * Scope is per host because these signals live in `HostView`, which Solid
 * remounts (keyed) on every host switch — the `host`-keyed name falls out
 * of where the state already lives rather than being a flag threaded
 * through a generic helper.
 */

const NAMESPACE = "drishti";

/** Storage key for a named preference scoped to one host. */
export function prefKey(pref: string, host: string): string {
  return `${NAMESPACE}:${pref}:${host}`;
}

/**
 * Read a stored preference, validated through `accept`. Falls back when the
 * key is absent, the stored value no longer validates (e.g. a sort column
 * that was removed), or storage is unavailable (Safari private mode throws
 * on access). `accept` defaults to accepting any non-null string — the
 * right default for free-text prefs like the process filter.
 */
export function readPref<T extends string>(
  key: string,
  fallback: T,
  accept: (raw: string) => boolean = () => true,
): T {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null && accept(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Persist a preference. Storage failures (private mode, quota) are
 * swallowed: a preference that can't be saved simply doesn't survive the
 * reload — it never breaks the live view.
 */
export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — preference won't persist, which is fine */
  }
}
