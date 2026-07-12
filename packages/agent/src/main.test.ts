import { describe, expect, it } from "bun:test";
import { serveAgent } from "./main";
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
