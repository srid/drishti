import { describe, expect, it } from "bun:test";
import { serveAgent, singleFlight } from "./main";
import type { ProcReader } from "./proc";

// A reader whose process enumeration is the expensive part — the darwin
// `ps` + `lsof` scan, modelled here as a promise the test controls. The
// system/cpu/network reads are trivial; only `readProcesses` blocks, so we
// can prove the agent answers the first RPC *without* waiting for that scan.
function gatedReader(processesGate: Promise<void>): ProcReader {
  return {
    os: "linux",
    readSystem: async () => ({
      loadAvg: [0, 0, 0],
      memUsed: 0,
      memTotal: 1,
      swapUsed: 0,
      swapTotal: 1,
      diskUsed: 0,
      diskTotal: 1,
      uptime: 0,
      os: "linux",
      hostname: "test",
    }),
    // Stand-in for the lsof-over-every-pid scan: blocks until released.
    readProcesses: async () => {
      await processesGate;
      return new Map();
    },
    readCpuCores: () => new Map(),
    readNetwork: async () => new Map(),
  };
}

describe("singleFlight", () => {
  it("skips fires that land while a run is in flight, and runs again after it settles", async () => {
    let releaseRun!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let runs = 0;
    const tick = singleFlight(async () => {
      runs++;
      await gate;
    });
    // Three interval fires over one slow read — the drishti#111 overlap
    // shape. Only the first may run; the others are skipped, not queued.
    void tick();
    void tick();
    void tick();
    expect(runs).toBe(1);
    releaseRun();
    // Drain past the wrapper's own await chain (inner tick resumption →
    // wrapper finally) so the guard is observably released.
    await Bun.sleep(0);
    // Settled: the next fire samples again.
    await tick();
    expect(runs).toBe(2);
  });

  it("releases the guard when the tick rejects (a failing poll never wedges)", async () => {
    let runs = 0;
    const tick = singleFlight(async () => {
      runs++;
      throw new Error("boom");
    });
    await tick().catch(() => {});
    await tick().catch(() => {});
    expect(runs).toBe(2);
  });
});

describe("serveAgent", () => {
  it("answers the first RPC without waiting for the process enumeration", async () => {
    let releaseProcesses!: () => void;
    const processesGate = new Promise<void>((resolve) => {
      releaseProcesses = resolve;
    });
    const reader = gatedReader(processesGate);

    let served = false;
    // Fake transport passed inline so it's contextually typed by serveAgent's
    // `serve` parameter (no exported type needed). It resolves immediately, as
    // if stdin closed at once. Were `serveAgent` to gate serving on the process
    // scan — the pre-fix behaviour — this fake would never be called and the
    // `await` below would hang the test out (timeout). That hang is exactly the
    // connect-handshake stall this reorder fixes, so a green run is the guard.
    await serveAgent(reader, async ({ onFirstRequest }) => {
      served = true;
      onFirstRequest();
    });

    expect(served).toBe(true);

    // Release the gate so the fire-and-forget first tick settles cleanly.
    releaseProcesses();
  });
});
