/**
 * Wake detector for the long-lived parent process.
 *
 * drishti runs on laptops: close the lid at home, reopen at a café. When
 * the machine sleeps, this process is frozen — and on resume every ssh
 * link to a remote host is stale (the far end dropped the TCP socket while
 * we were suspended). Left alone, the parent doesn't notice until ssh's
 * keepalive fails ~30s later, so the UI shows a healthy host whose RPCs
 * silently hang.
 *
 * There is no portable Node "resume" event, but a suspend leaves a
 * fingerprint: a timer that should fire every `intervalMs` instead fires
 * far later, because the event loop didn't run while the process was
 * frozen. We watch the wall-clock gap between ticks; a gap well past the
 * interval means we just woke. That's the signal to force every host to
 * re-probe its link now (`registry.recheckAll`) rather than wait out ssh.
 *
 * The same fires for any long stall (a debugger pause, a wedged sync call),
 * which is harmless: a recheck on a genuinely-healthy host just blips it
 * through one fast reconnect.
 */

export interface WakeMonitorOptions {
  /** Fired when a wake (clock gap past the threshold) is detected, with
   *  the observed gap in ms. */
  onWake: (gapMs: number) => void;
  /** How often to sample the clock. Default 1000ms. */
  intervalMs?: number;
  /** A gap beyond this implies the process was suspended (machine slept)
   *  rather than a merely-slow tick. Default 5000ms — comfortably past
   *  GC/event-loop jitter, well under any real sleep. */
  thresholdMs?: number;
  /** Wall clock, injectable for tests. Default `Date.now`. */
  now?: () => number;
}

/** Start watching for wakes. Returns a `stop()` that clears the timer.
 *  The probe timer is `unref`'d so it never holds the process open on its
 *  own. */
export function startWakeMonitor(opts: WakeMonitorOptions): () => void {
  const intervalMs = opts.intervalMs ?? 1000;
  const thresholdMs = opts.thresholdMs ?? 5000;
  const now = opts.now ?? Date.now;

  let last = now();
  const id = setInterval(() => {
    const t = now();
    const gap = t - last;
    last = t;
    if (gap > thresholdMs) opts.onWake(gap);
  }, intervalMs);

  (id as unknown as { unref?: () => void }).unref?.();

  return () => clearInterval(id);
}
