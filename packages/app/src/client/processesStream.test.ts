import { describe, expect, it } from "bun:test";
import { defineSurface } from "@kolu/surface/define";
import { directLink } from "@kolu/surface/links/direct";
import { implementSurface, inMemoryChannelByName } from "@kolu/surface/server";
import { streamCall } from "@kolu/surface/client";
import { createSubscription } from "@kolu/surface/solid";
import {
  type Pid,
  type Process,
  ProcessesSnapshotMessage,
  type ProcessesSnapshotMsg,
} from "drishti-common";
import { createEffect, createRoot } from "solid-js";
import { z } from "zod";
import { foldProcessesMessage } from "./processesStream";

const proc = (command: string, cpuPct = 0): Process => ({
  user: "root",
  cpuPct,
  rssBytes: 1024,
  command,
  cwd: "/",
  ppid: 1,
  state: "S",
  nice: 0,
  threads: 1,
  startedAtMs: 0,
});

describe("foldProcessesMessage", () => {
  it("a snapshot frame replaces the whole map", () => {
    const out = foldProcessesMessage(
      { 9: proc("stale") },
      { kind: "snapshot", entries: [[1, proc("init")], [2, proc("bash")]] },
    );
    expect(Object.keys(out).sort()).toEqual(["1", "2"]);
    expect(out[9]).toBeUndefined();
  });

  it("a delta frame upserts and removes onto a copy (input untouched)", () => {
    const prev = { 1: proc("init"), 2: proc("bash") };
    const out = foldProcessesMessage(prev, {
      kind: "delta",
      upserts: [[3, proc("vim")], [1, proc("init", 5)]],
      removes: [2],
    });
    expect(out[1]?.cpuPct).toBe(5);
    expect(out[3]?.command).toBe("vim");
    expect(out[2]).toBeUndefined();
    // The accumulator is folded immutably — the previous map is not mutated.
    expect(prev[2]).toBeDefined();
    expect(prev[1]?.cpuPct).toBe(0);
  });
});

// ── The integration test: the production consumer wired exactly as <HostView>
// wires it — `createSubscription` + `foldProcessesMessage` over a real surface
// (defineSurface → implementSurface → directLink) — read FINE-GRAINED. ───────

// A minimal surface carrying ONLY processesSnapshot, reusing the real wire
// schema so the consumer sees the exact `ProcessesSnapshotMsg` shape.
const probeSurface = defineSurface({
  streams: {
    processesSnapshot: {
      inputSchema: z.object({}),
      outputSchema: ProcessesSnapshotMessage,
    },
  },
});

/** A hand-fed async iterable — the test pushes frames whenever it wants, so
 *  snapshot/delta ordering is deterministic rather than timing-dependent. */
function makeFeed() {
  const queue: ProcessesSnapshotMsg[] = [];
  let resolve: ((r: IteratorResult<ProcessesSnapshotMsg>) => void) | null = null;
  let closed = false;
  return {
    push(msg: ProcessesSnapshotMsg) {
      if (resolve) {
        resolve({ value: msg, done: false });
        resolve = null;
      } else queue.push(msg);
    },
    close() {
      closed = true;
      if (resolve) {
        resolve({ value: undefined as never, done: true });
        resolve = null;
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<ProcessesSnapshotMsg> {
        return {
          next() {
            if (queue.length > 0)
              return Promise.resolve({ value: queue.shift()!, done: false });
            if (closed)
              return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((r) => {
              resolve = r;
            });
          },
        };
      },
    } as AsyncIterable<ProcessesSnapshotMsg>,
  };
}

function serve(feed: ReturnType<typeof makeFeed>) {
  const { router } = implementSurface(probeSurface, {
    channel: inMemoryChannelByName(),
    streams: {
      processesSnapshot: {
        source: async function* (_input, signal) {
          for await (const msg of feed.iterable) {
            if (signal?.aborted) break;
            yield msg;
          }
        },
      },
    },
  });
  return directLink<typeof probeSurface.contract>(router);
}

const flush = () => new Promise((r) => setTimeout(r, 20));

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never met");
    await flush();
  }
}

describe("processesSnapshot consumer — createSubscription + reduce, read fine-grained", () => {
  it("a same-shape delta (only a nested field changes) re-notifies a fine-grained reader", async () => {
    // This is the regression the value-bearing rewrite fixes: with the old
    // coarse "read the whole map and copy it into a store" effect, two
    // consecutive deltas of the SAME array shape (same single upsert, empty
    // removes) that differ only in `cpuPct` were COALESCED — the second was
    // dropped and the live value froze. Here the table renders fine-grained
    // (`processes()[pid]?.cpuPct`), so each in-place leaf update re-notifies.
    const feed = makeFeed();
    const link = serve(feed);

    await createRoot(async (dispose) => {
      const sub = createSubscription<ProcessesSnapshotMsg, Record<Pid, Process>>(
        () => streamCall(link.surface.processesSnapshot.get, {}),
        { reduce: foldProcessesMessage, initial: {} },
      );
      const processes = (): Record<Pid, Process> => sub() ?? {};

      // A fine-grained reader of one cell — exactly how <ProcessRow> reads it.
      let observedCpu: number | undefined;
      createEffect(() => {
        observedCpu = processes()[1]?.cpuPct;
      });

      feed.push({ kind: "snapshot", entries: [[1, proc("hot", 10)]] });
      await waitFor(() => processes()[1]?.cpuPct === 10);
      expect(observedCpu).toBe(10);

      // First delta — same shape (one upsert, no removes), cpu 10 → 20.
      feed.push({ kind: "delta", upserts: [[1, proc("hot", 20)]], removes: [] });
      await waitFor(() => processes()[1]?.cpuPct === 20);
      expect(observedCpu).toBe(20);

      // Second delta — IDENTICAL shape, cpu 20 → 30. The coalescing bug dropped
      // exactly this frame; the fine-grained reader must observe 30.
      feed.push({ kind: "delta", upserts: [[1, proc("hot", 30)]], removes: [] });
      await waitFor(() => processes()[1]?.cpuPct === 30);
      expect(observedCpu).toBe(30);

      feed.close();
      dispose();
    });
  });

  it("accumulates a snapshot then upserts/removes across deltas", async () => {
    const feed = makeFeed();
    const link = serve(feed);

    await createRoot(async (dispose) => {
      const sub = createSubscription<ProcessesSnapshotMsg, Record<Pid, Process>>(
        () => streamCall(link.surface.processesSnapshot.get, {}),
        { reduce: foldProcessesMessage, initial: {} },
      );
      const processes = (): Record<Pid, Process> => sub() ?? {};

      feed.push({
        kind: "snapshot",
        entries: [[1, proc("init")], [2, proc("bash")]],
      });
      await waitFor(() => Object.keys(processes()).length === 2);
      expect(Object.keys(processes()).sort()).toEqual(["1", "2"]);

      feed.push({
        kind: "delta",
        upserts: [[3, proc("vim")]],
        removes: [2],
      });
      await waitFor(
        () => processes()[3] !== undefined && processes()[2] === undefined,
      );
      expect(Object.keys(processes()).sort()).toEqual(["1", "3"]);

      feed.close();
      dispose();
    });
  });
});
