import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "bun:test";
import { parseOsfactsOutput } from "osfacts-client";
import {
  budgetedExec,
  computeNetThroughput,
  createProcReader,
  createOsfactsProcessReader,
  darwinReader,
  diskBytesFromStatfs,
  type ExecFn,
  type NetCounters,
  parseMeminfo,
  parseNetstatIb,
  parseProcNetDev,
  parseSwapusage,
  parseVmStat,
  processesFromOsfacts,
} from "./proc";

describe("osfacts process inspection", () => {
  const fixture = [
    "V\t1",
    "P\t1\t0\tinit",
    "P\t42\t1\tserver",
    "L\t42\t8080\t00000000",
    "U\t42\tEACCES",
    "U\t99\tEPERM",
    "",
  ].join("\n");

  it("maps parsed P/L/U rows without confusing unreadable with empty", () => {
    const processes = processesFromOsfacts(parseOsfactsOutput(fixture));

    expect(processes.get(1)).toEqual({
      command: "init",
      ppid: 0,
      listeners: [],
      unreadableErrno: null,
    });
    expect(processes.get(42)).toEqual({
      command: "server",
      ppid: 1,
      listeners: [{ port: 8080, address: "00000000" }],
      unreadableErrno: "EACCES",
    });
    expect(processes.get(99)).toEqual({
      command: "",
      ppid: 0,
      listeners: [],
      unreadableErrno: "EPERM",
    });
  });

  it("reads the host process tree through osfacts at the baked path", async () => {
    const calls: Array<{ bin: string; roots: readonly number[] }> = [];
    const reading = parseOsfactsOutput(fixture);
    const read = createOsfactsProcessReader(
      "/nix/store/osfacts/bin/osfacts",
      async (bin, roots) => {
        calls.push({ bin, roots });
        return reading;
      },
    );

    expect(await read()).toEqual(processesFromOsfacts(reading));
    expect(calls).toEqual([
      { bin: "/nix/store/osfacts/bin/osfacts", roots: [1] },
    ]);
  });

  it("does not make readable system processes permission-blind for listeners", async () => {
    // Production regression (zest monitoring naiveintent): the normal SSH
    // user received 202 P rows, zero L rows, and 41 `U … EACCES` rows. The P
    // rows prove process identity was readable; with only --procs + --ports
    // requested, EACCES/EPERM on the same pid means the listener facet was
    // lost to the agent user's privileges. Exercise the real baked binary
    // through the same reader the deployed agent constructs.
    const processes = await createProcReader().readProcesses();
    const permissionBlind = Array.from(processes, ([pid, process]) => ({
      pid,
      command: process.command,
      errno: process.unreadableErrno,
    })).filter(
      ({ command, errno }) =>
        command !== "" && (errno === "EACCES" || errno === "EPERM"),
    );

    expect({
      count: permissionBlind.length,
      sample: permissionBlind.slice(0, 5),
    }).toEqual({ count: 0, sample: [] });
  });

  it("keeps the remaining darwin telemetry children on one kill-budget boundary", async () => {
    let options:
      | { timeout?: number; killSignal?: NodeJS.Signals; maxBuffer?: number }
      | undefined;
    const execImpl: ExecFn = (_file, _args, opts) => {
      options = opts;
      return Promise.resolve({ stdout: "" });
    };

    await budgetedExec(execImpl)("vm_stat", []);
    expect(options?.timeout).toBe(20_000);
    expect(options?.killSignal).toBe("SIGKILL");
    expect(options?.maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });
});

describe("parseProcNetDev", () => {
  // Real /proc/net/dev shape: two header lines, then `name: rx_bytes
  // rx_packets …(8 rx fields)… tx_bytes tx_packets …`.
  const sample = [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo:  123456    789    0    0    0     0          0         0   123456     789    0    0    0     0       0          0",
    "  eth0: 1000000   5000    0    0    0     0          0         0   2000000    6000    0    0    0     0       0          0",
    "",
  ].join("\n");

  it("reads receive bytes (field 1) and transmit bytes (field 9) per interface", () => {
    const m = parseProcNetDev(sample);
    expect(m.get("eth0")).toEqual({ rxBytes: 1000000, txBytes: 2000000 });
  });

  it("parses every interface faithfully, including loopback (filtering is the reader's job)", () => {
    const m = parseProcNetDev(sample);
    expect(m.get("lo")).toEqual({ rxBytes: 123456, txBytes: 123456 });
    expect([...m.keys()].sort()).toEqual(["eth0", "lo"]);
  });

  it("skips the two header lines (no colon)", () => {
    const m = parseProcNetDev(sample);
    expect(m.has("face")).toBe(false);
    expect(m.has("Inter-")).toBe(false);
  });
});

describe("parseNetstatIb", () => {
  // darwin `netstat -ib`: one <Link#N> aggregate row per interface, plus
  // address-family rows we ignore. The lo0 row has no MAC (Address blank),
  // the en0 row does — exercising the count-from-the-right column logic.
  const sample = [
    "Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
    "lo0   16384 <Link#1>                          100     0      12000      100     0      12000     0",
    "en0   1500  <Link#2>    a1:b2:c3:d4:e5:f6    5000     0    8000000     4000     0    3000000     0",
    "en0   1500  192.168.1     192.168.1.5         5000     0    8000000     4000     0    3000000     0",
    "",
  ].join("\n");

  it("reads Ibytes/Obytes from the <Link#> row regardless of the Address column", () => {
    const m = parseNetstatIb(sample);
    expect(m.get("en0")).toEqual({ rxBytes: 8000000, txBytes: 3000000 });
    expect(m.get("lo0")).toEqual({ rxBytes: 12000, txBytes: 12000 });
  });

  it("ignores non-<Link#> address-family rows (no double counting)", () => {
    const m = parseNetstatIb(sample);
    expect([...m.keys()].sort()).toEqual(["en0", "lo0"]);
  });
});

describe("readSystem disk probe (decoupled statfs)", () => {
  it("serves the cached observation and fills after the probe lands (never awaits the syscall)", async () => {
    // statfs has no timeout knob, so readSystem must not await it under the
    // settlement-dependent singleFlight guard — it serves the last-known
    // value and a background probe refreshes it. On this test host statfs(/)
    // succeeds, so after a microtask drain the real capacity appears.
    const execImpl: ExecFn = () => Promise.resolve({ stdout: "" });
    const reader = darwinReader(execImpl, "/nix/store/osfacts/bin/osfacts");
    await reader.readSystem(); // kicks the probe (or serves an already-landed cache)
    await Bun.sleep(10); // let the real statfs land
    const sys = await reader.readSystem();
    expect(sys.diskTotal).toBeGreaterThan(0);
  });
});

describe("child kill budget (real execFile contract)", () => {
  it("a hung child is killed at the timeout — the utility PROCESS is dead, not merely signalled", async () => {
    // The enricher trusts node's execFile timeout to reap a hung child —
    // prove that contract holds in this runtime rather than assume it. NOTE
    // execFile, not exec: exec's timeout signals the intermediary shell, and
    // whether the utility dies with it depends on the shell's
    // exec-last-command optimization. execFile targets the utility directly,
    // and the pin verifies the actual PID is gone (err.killed alone only
    // proves a signal was SENT).
    const execFile = promisify(execFileCb);
    const started = Date.now();
    let killed = false;
    const pending = execFile("sleep", ["60"], {
      timeout: 250,
      killSignal: "SIGKILL",
    });
    const childPid = pending.child.pid;
    try {
      await pending;
    } catch (err) {
      killed = (err as { killed?: boolean }).killed === true;
    }
    expect(killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The process must actually be gone (kill(pid, 0) raises ESRCH once the
    // child is reaped). Poll briefly: node reaps on the exit event, which can
    // land a beat after the promise settles.
    expect(childPid).toBeDefined();
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      try {
        process.kill(childPid as number, 0);
        await Bun.sleep(50);
      } catch {
        gone = true; // ESRCH — no such process
      }
    }
    expect(gone).toBe(true);
  });
});

describe("parseVmStat", () => {
  // Realistic `vm_stat` output on Apple Silicon (16 KiB pages). The header
  // carries the page size; each line is `Label:   <count>.`.
  const sample = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    'Pages free:                              100000.',
    'Pages active:                            500000.',
    'Pages inactive:                          200000.',
    'Pages speculative:                        30000.',
    'Pages throttled:                              0.',
    'Pages wired down:                        300000.',
    'Pages purgeable:                          40000.',
    '"Translation faults":                 123456789.',
    "Pages copy-on-write:                    1000000.",
    "Pages zero filled:                    900000000.",
    "Pages reactivated:                       500000.",
    "Pages purged:                            100000.",
    'File-backed pages:                       150000.',
    'Anonymous pages:                         550000.',
    "Pages stored in compressor:              200000.",
    "Pages occupied by compressor:            100000.",
    "",
  ].join("\n");

  // available = pageSize × (free + inactive + speculative + purgeable).
  // "File-backed pages" is deliberately excluded: it tallies all
  // file-backed pages regardless of LRU list, double-counting the
  // file-backed pages already inside "Pages inactive" / "Pages
  // speculative", which would let available exceed physical total.
  const PAGE = 16384;
  const reclaimablePages = 100000 + 200000 + 30000 + 40000;

  it("derives cache-aware available from reclaimable page classes, parsing page size from the header", () => {
    const mem = parseVmStat(sample);
    expect(mem.available).toBe(PAGE * reclaimablePages);
  });

  it("excludes File-backed pages so available cannot double-count inactive/speculative file pages", () => {
    // File-backed pages (150000) overlap the inactive + speculative counts;
    // adding it would inflate available past the genuine reclaimable set
    // and could push memUsed (total - available) negative.
    const withFileBacked = reclaimablePages + 150000;
    expect(parseVmStat(sample).available).toBe(PAGE * reclaimablePages);
    expect(parseVmStat(sample).available).toBeLessThan(PAGE * withFileBacked);
  });

  it("lets an explicit pageSize argument override the header", () => {
    const mem = parseVmStat(sample, 4096);
    expect(mem.available).toBe(4096 * reclaimablePages);
  });

  it("falls back to 0-count for page classes absent from the dump", () => {
    const minimal = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                              100000.",
      "",
    ].join("\n");
    // Only free pages are reclaimable here; the rest default to 0.
    expect(parseVmStat(minimal).available).toBe(PAGE * 100000);
  });
});

describe("parseMeminfo", () => {
  it("reads MemTotal/MemAvailable + SwapTotal/SwapFree as bytes (kB × 1024)", () => {
    const sample = [
      "MemTotal:       16384000 kB",
      "MemFree:         1000000 kB",
      "MemAvailable:    8192000 kB",
      "Buffers:          500000 kB",
      "SwapTotal:       2048000 kB",
      "SwapFree:         512000 kB",
      "",
    ].join("\n");
    expect(parseMeminfo(sample)).toEqual({
      total: 16384000 * 1024,
      available: 8192000 * 1024,
      swapTotal: 2048000 * 1024,
      swapFree: 512000 * 1024,
    });
  });

  it("reports 0 swap when the host has none (fields absent)", () => {
    const sample = ["MemTotal:  16384000 kB", "MemAvailable: 8192000 kB"].join(
      "\n",
    );
    const mem = parseMeminfo(sample);
    expect(mem.swapTotal).toBe(0);
    expect(mem.swapFree).toBe(0);
  });
});

describe("parseSwapusage", () => {
  it("reads used/total from `sysctl -n vm.swapusage`, scaling M by 1024²", () => {
    const sample =
      "total = 2048.00M  used = 1234.50M  free = 813.50M  (encrypted)";
    expect(parseSwapusage(sample)).toEqual({
      swapUsed: Math.round(1234.5 * 1024 ** 2),
      swapTotal: 2048 * 1024 ** 2,
    });
  });

  it("scales a G suffix by 1024³", () => {
    expect(parseSwapusage("total = 6.00G  used = 1.50G  free = 4.50G")).toEqual({
      swapUsed: Math.round(1.5 * 1024 ** 3),
      swapTotal: 6 * 1024 ** 3,
    });
  });

  it("reads 0/0 for a swapless mac and empty output (never NaN)", () => {
    expect(parseSwapusage("total = 0.00M  used = 0.00M  free = 0.00M")).toEqual({
      swapUsed: 0,
      swapTotal: 0,
    });
    expect(parseSwapusage("")).toEqual({ swapUsed: 0, swapTotal: 0 });
  });
});

describe("diskBytesFromStatfs", () => {
  it("derives used (blocks − bfree) and total (blocks) in bytes", () => {
    // 100 blocks total, 25 free, 4096-byte blocks → 75% occupied.
    expect(
      diskBytesFromStatfs({ bsize: 4096, blocks: 100, bfree: 25 }),
    ).toEqual({ diskUsed: 75 * 4096, diskTotal: 100 * 4096 });
  });

  it("yields zeros for an empty filesystem report (never NaN)", () => {
    expect(diskBytesFromStatfs({ bsize: 0, blocks: 0, bfree: 0 })).toEqual({
      diskUsed: 0,
      diskTotal: 0,
    });
  });
});

describe("computeNetThroughput", () => {
  const prev: Map<string, NetCounters> = new Map([
    ["eth0", { rxBytes: 1000, txBytes: 2000 }],
  ]);

  it("derives bytes/sec from the counter delta over the window", () => {
    const cur: Map<string, NetCounters> = new Map([
      ["eth0", { rxBytes: 3000, txBytes: 5000 }],
    ]);
    expect(computeNetThroughput(prev, cur, 2).get("eth0")).toEqual({
      rxBytes: 3000,
      txBytes: 5000,
      rxRate: 1000,
      txRate: 1500,
    });
  });

  it("reports 0 rate on the first tick (winSec <= 0)", () => {
    const cur: Map<string, NetCounters> = new Map([
      ["eth0", { rxBytes: 3000, txBytes: 5000 }],
    ]);
    const nic = computeNetThroughput(prev, cur, 0).get("eth0");
    expect(nic?.rxRate).toBe(0);
    expect(nic?.txRate).toBe(0);
  });

  it("reports 0 rate for an interface with no previous counters", () => {
    const cur: Map<string, NetCounters> = new Map([
      ["wlan0", { rxBytes: 9999, txBytes: 8888 }],
    ]);
    const nic = computeNetThroughput(prev, cur, 2).get("wlan0");
    expect(nic).toEqual({
      rxBytes: 9999,
      txBytes: 8888,
      rxRate: 0,
      txRate: 0,
    });
  });

  it("clamps a counter that ran backwards (reset / hot-swap) to 0", () => {
    const cur: Map<string, NetCounters> = new Map([
      ["eth0", { rxBytes: 100, txBytes: 50 }],
    ]);
    const nic = computeNetThroughput(prev, cur, 2).get("eth0");
    expect(nic?.rxRate).toBe(0);
    expect(nic?.txRate).toBe(0);
  });
});
