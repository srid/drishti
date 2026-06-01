import { describe, expect, it } from "bun:test";
import { startWakeMonitor } from "./wakeMonitor";

/**
 * The wake monitor's whole job is to tell a normal tick (the event loop
 * ran on schedule) from a wake (the process was frozen across a sleep, so
 * the timer fired far late). We drive that distinction with an injected
 * clock: the probe timer fires on real time (kept short here), but the
 * *gap* it measures comes from how far we advance the injected clock —
 * decoupling "a sleep happened" from real wall-clock waits.
 */
describe("startWakeMonitor", () => {
  // A clock the monitor reads via its `now` injection, so the test owns
  // "wall-clock time" independently of when the probe timer actually fires.
  function clockAt(start: number) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("fires onWake when the clock jumps far past the interval (a sleep)", async () => {
    const clock = clockAt(0);
    const gaps: number[] = [];
    const stop = startWakeMonitor({
      onWake: (g) => gaps.push(g),
      intervalMs: 20,
      thresholdMs: 100,
      now: clock.now,
    });

    // The process was "suspended" ~2 minutes: the next tick sees a huge gap.
    clock.advance(120_000);
    await Bun.sleep(60); // let the probe timer fire at least once

    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps[0]).toBeGreaterThanOrEqual(120_000);
    stop();
  });

  it("stays quiet on normal ticks (no false wake)", async () => {
    const clock = clockAt(0);
    const gaps: number[] = [];
    const stop = startWakeMonitor({
      onWake: (g) => gaps.push(g),
      intervalMs: 20,
      thresholdMs: 100,
      now: clock.now,
    });

    // On-schedule ticks: the clock advances by ~one interval each time,
    // never past the threshold.
    for (let i = 0; i < 3; i++) {
      clock.advance(20);
      await Bun.sleep(40);
    }

    expect(gaps.length).toBe(0);
    stop();
  });

  it("stops probing after stop()", async () => {
    const clock = clockAt(0);
    const gaps: number[] = [];
    const stop = startWakeMonitor({
      onWake: (g) => gaps.push(g),
      intervalMs: 20,
      thresholdMs: 100,
      now: clock.now,
    });

    stop();
    clock.advance(120_000);
    await Bun.sleep(60);

    expect(gaps.length).toBe(0);
  });
});
