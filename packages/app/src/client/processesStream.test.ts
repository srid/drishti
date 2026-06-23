import { describe, expect, it } from "bun:test";
import { defineSurface } from "@kolu/surface/define";
import { directLink } from "@kolu/surface/links/direct";
import { implementSurface, inMemoryChannelByName } from "@kolu/surface/server";
import { surfaceClient } from "@kolu/surface/solid";
import {
  type Pid,
  type Process,
  ProcessesSnapshotMessage,
  type ProcessesSnapshotMsg,
} from "drishti-common";
import { createEffect, createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { z } from "zod";
import { applyProcessesMessage } from "./processesStream";

// A minimal surface carrying ONLY the processesSnapshot stream, reusing the
// real wire schema so the consumer under test sees the exact
// `ProcessesSnapshotMsg` shape it sees in production. `implementSurface`
// requires deps for every primitive, so trimming the surface to one stream is
// what keeps this hermetic — no system cells, collections, or metric history
// to stand up.
const probeSurface = defineSurface({
  streams: {
    processesSnapshot: {
      inputSchema: z.object({}),
      outputSchema: ProcessesSnapshotMessage,
    },
  },
});

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

describe("processesSnapshot consumer — .streams.use() + reconcile", () => {
  it("folds a snapshot then deltas into the store, re-notifying per delta", async () => {
    const feed = makeFeed();
    const app = surfaceClient(probeSurface, serve(feed));

    await createRoot(async (dispose) => {
      const [processes, setProcesses] = createStore<Record<Pid, Process>>({});
      const removed: Pid[] = [];

      // The graduated consumer: the declarative `.streams.use()` hook drives
      // the same reconcile fold the production <HostView> uses.
      const snapshot = app.streams.processesSnapshot.use(() => ({}));
      createEffect(() => {
        const msg = snapshot();
        if (msg === undefined) return;
        applyProcessesMessage(msg, setProcesses, (pid) => removed.push(pid));
      });

      // Before the first frame the store is empty.
      expect(Object.keys(processes)).toEqual([]);

      // Snapshot → full reconcile.
      feed.push({
        kind: "snapshot",
        entries: [
          [1, proc("init")],
          [2, proc("bash")],
        ],
      });
      await waitFor(() => processes[1] !== undefined && processes[2] !== undefined);
      expect(Object.keys(processes).sort()).toEqual(["1", "2"]);
      expect(processes[1]?.command).toBe("init");

      // A reactive reader of one cell — proves the store re-notifies a
      // fine-grained dependent when a later delta upserts that PID (the
      // "reconcile break" the note says only a reactive store catches).
      let observedCpu: number | undefined;
      createEffect(() => {
        observedCpu = processes[3]?.cpuPct;
      });
      await flush();

      // First delta: upsert 3, mutate 1, remove 2.
      feed.push({
        kind: "delta",
        upserts: [
          [3, proc("vim", 5)],
          [1, proc("init", 1)],
        ],
        removes: [2],
      });
      await waitFor(() => processes[3] !== undefined && processes[2] === undefined);
      expect(processes[1]?.cpuPct).toBe(1);
      expect(processes[3]?.command).toBe("vim");
      expect(processes[2]).toBeUndefined();
      expect(removed).toEqual([2]);
      expect(observedCpu).toBe(5);

      // Second delta on the SAME pid — the reactive cell must re-notify.
      feed.push({ kind: "delta", upserts: [[3, proc("vim", 9)]], removes: [] });
      await waitFor(() => processes[3]?.cpuPct === 9);
      expect(observedCpu).toBe(9);

      feed.close();
      dispose();
    });
  });
});
