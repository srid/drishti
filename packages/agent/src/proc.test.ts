import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "bun:test";
import {
  type BudgetedRun,
  budgetedExec,
  computeNetThroughput,
  createCwdEnricher,
  darwinReader,
  diskBytesFromStatfs,
  type ExecFn,
  type NetCounters,
  parseLsofCwd,
  parseMeminfo,
  parseNetstatIb,
  parseProcNetDev,
  parseProcStat,
  parsePsLine,
  parseSwapusage,
  parseVmStat,
} from "./proc";

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

describe("parsePsLine", () => {
  // `ps -axo pid=,user=,pcpu=,rss=,ppid=,nice=,state=,comm=` — rss is in KB
  // on macOS, comm is last/greedy (may contain spaces), and ppid/nice/state
  // sit between rss and comm.
  // parsePsLine returns a DarwinProcRaw — the fields a ps line carries. cwd
  // (lsof), threads, and startedAtMs are not on the raw; they're filled at the
  // Process-construction site in darwinReader.readProcesses.
  it("parses rss (KB) into absolute resident bytes and the ppid/nice/state fields", () => {
    const raw = parsePsLine("  501 alice 12.5 348160 1 0 S /usr/bin/foo");
    expect(raw).not.toBeNull();
    expect(raw!.pid).toBe(501);
    expect(raw!.user).toBe("alice");
    expect(raw!.cpuPct).toBe(12.5);
    // 348160 KB × 1024 = absolute bytes (≈ 356 MB).
    expect(raw!.rssBytes).toBe(348160 * 1024);
    expect(raw!.command).toBe("/usr/bin/foo");
    expect(raw!.ppid).toBe(1);
    expect(raw!.nice).toBe(0);
    expect(raw!.state).toBe("S");
  });

  it("keeps a command with embedded spaces intact (comm is the trailing field)", () => {
    const raw = parsePsLine("99 root 0.0 2048 1 -5 Ss com.apple.Some Helper")!;
    expect(raw.command).toBe("com.apple.Some Helper");
    expect(raw.rssBytes).toBe(2048 * 1024);
    // negative nice survives; the multi-char state token collapses to its
    // leading code (`Ss` → `S`) for parity with linux's single-char state.
    expect(raw.nice).toBe(-5);
    expect(raw.state).toBe("S");
  });

  it("returns null for blank or malformed lines", () => {
    expect(parsePsLine("")).toBeNull();
    expect(parsePsLine("   ")).toBeNull();
    expect(parsePsLine("not a ps line")).toBeNull();
    // The pre-extension 5-column shape no longer matches (missing
    // ppid/nice/state before comm).
    expect(parsePsLine("501 alice 12.5 348160 /usr/bin/foo")).toBeNull();
  });
});

describe("parseLsofCwd", () => {
  // `lsof -nP -d cwd -Fpn` field output: one `p<pid>` line per process, then
  // an `n<path>` line for the cwd descriptor. lsof prepends an `f cwd` marker
  // for the fd in real output — the parser must ignore it.
  const sample = [
    "p501",
    "fcwd",
    "n/Users/alice/code/drishti",
    "p502",
    "fcwd",
    "n/tmp",
    "",
  ].join("\n");

  it("maps each pid to the cwd path on its following n line", () => {
    const m = parseLsofCwd(sample);
    expect(m.get(501)).toBe("/Users/alice/code/drishti");
    expect(m.get(502)).toBe("/tmp");
    expect([...m.keys()].sort()).toEqual([501, 502]);
  });

  it("omits pids whose cwd lsof could not resolve (no n line)", () => {
    // pid 777 is denied (other user, no root) — lsof emits the p line but no
    // n line, so it stays absent and the reader falls back to "" via `?? ""`.
    const denied = ["p777", "p778", "fcwd", "n/var/run", ""].join("\n");
    const m = parseLsofCwd(denied);
    expect(m.has(777)).toBe(false);
    expect(m.get(778)).toBe("/var/run");
  });

  it("truncates an over-long cwd to PROC_STRING_MAX (parity with linux)", () => {
    const long = "/" + "a".repeat(300);
    const m = parseLsofCwd(["p1", `n${long}`, ""].join("\n"));
    expect(m.get(1)!.length).toBe(200);
  });

  it("returns an empty map for blank output (lsof absent or failed)", () => {
    expect(parseLsofCwd("").size).toBe(0);
  });
});

describe("darwinReader cwd enrichment discipline (drishti#111)", () => {
  // One ps row is enough — the pins are about the lsof CHILD's lifecycle,
  // not row parsing (parsePsLine has its own suite above).
  const PS_OUT = "  501 alice 12.5 348160 1 0 S /usr/bin/foo\n";

  /** A fake exec whose lsof child the test controls: hangs until the test
   *  resolves it, counting spawns and capturing the exec options so the pins
   *  can assert the single-flight / budget contract. ps resolves instantly. */
  function fakeExecEnv() {
    const env = {
      lsofSpawns: 0,
      resolveLsof: undefined as ((v: { stdout: string }) => void) | undefined,
    };
    const execImpl: ExecFn = (file, _args, _opts) => {
      if (file === "ps") return Promise.resolve({ stdout: PS_OUT });
      if (file === "lsof") {
        env.lsofSpawns++;
        return new Promise((r) => {
          env.resolveLsof = r;
        });
      }
      return Promise.reject(new Error(`unexpected exec: ${file}`));
    };
    return { env, execImpl };
  }

  it("spawns exactly one lsof across N polls while the child is in flight (single-flight)", async () => {
    const { env, execImpl } = fakeExecEnv();
    const reader = darwinReader(execImpl);
    // Three poll ticks land while the enrichment child hangs. The rasam
    // pileup (drishti#111) was this exact overlap on pre-migration binaries;
    // the reader must own the invariant now: one child, never N.
    await reader.readProcesses();
    await reader.readProcesses();
    await reader.readProcesses();
    expect(env.lsofSpawns).toBe(1);
  });

  it("completes the poll without cwd while the child is in flight (never wedges the table)", async () => {
    const { execImpl } = fakeExecEnv();
    const reader = darwinReader(execImpl);
    // A hung lsof must not hold the processes table hostage: the poll
    // resolves at ps speed with the last-known (here: empty) cwd.
    const raced = await Promise.race([
      reader.readProcesses(),
      Bun.sleep(250).then(() => "wedged" as const),
    ]);
    expect(raced).not.toBe("wedged");
    const procs = raced as Map<number, { cwd: string }>;
    expect(procs.get(501)?.cwd).toBe("");
  });

  it("budgets EVERY darwin child — a hung ps/lsof/vm_stat/netstat would freeze its collection under the settlement-dependent guards", async () => {
    const seen = new Map<
      string,
      | { timeout?: number; killSignal?: NodeJS.Signals; maxBuffer?: number }
      | undefined
    >();
    const execImpl: ExecFn = (file, _args, opts) => {
      seen.set(file, opts);
      if (file === "ps") return Promise.resolve({ stdout: PS_OUT });
      return Promise.resolve({ stdout: "" });
    };
    const reader = darwinReader(execImpl);
    await reader.readProcesses();
    await reader.readSystem();
    await reader.readNetwork();
    for (const child of ["ps", "lsof", "vm_stat", "sysctl", "netstat"]) {
      // 20s, not 5s: rasam's pathological-but-COMPLETING lsof took ~14s — a
      // 5s budget would kill it every attempt and deliver no cwd forever on
      // exactly the host that needs the data; the budget exists to reap
      // genuinely-hung children, and decoupling makes it invisible to the
      // table's cadence. maxBuffer explicit: node's 1 MiB default would
      // reject a huge host's lsof/ps output into the silent failure backoff.
      expect(seen.get(child)?.timeout).toBe(20_000);
      expect(seen.get(child)?.killSignal).toBe("SIGKILL");
      expect(seen.get(child)?.maxBuffer).toBeGreaterThanOrEqual(
        16 * 1024 * 1024,
      );
    }
  });

  it("budgetedExec is the one boundary that attaches the budget — the narrowed run has no options socket to forget", async () => {
    // The enumerating pin above is a regression net over the KNOWN children;
    // this is the structural pin: every darwin spawn goes through
    // budgetedExec, so asserting the wrapper once covers any child added
    // later.
    let opts:
      | { timeout?: number; killSignal?: NodeJS.Signals; maxBuffer?: number }
      | undefined;
    const execImpl: ExecFn = (_file, _args, o) => {
      opts = o;
      return Promise.resolve({ stdout: "" });
    };
    await budgetedExec(execImpl)("anything", []);
    expect(opts?.timeout).toBe(20_000);
    expect(opts?.killSignal).toBe("SIGKILL");
    expect(opts?.maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  it("merges the landed cwd map into subsequent polls (stale-beats-blank)", async () => {
    const { env, execImpl } = fakeExecEnv();
    const reader = darwinReader(execImpl);
    await reader.readProcesses(); // fires the child; rows blank this tick
    env.resolveLsof?.({ stdout: ["p501", "fcwd", "n/Users/alice/code", ""].join("\n") });
    await Bun.sleep(0); // let the landed child's map install
    const procs = await reader.readProcesses();
    expect(procs.get(501)?.cwd).toBe("/Users/alice/code");
  });
});

describe("createCwdEnricher gap + backoff (fake clock)", () => {
  /** Harness: a controllable child (resolve/reject per spawn) under a fake
   *  clock, so the gap/backoff arithmetic is pinned deterministically. */
  function harness() {
    const h = {
      t: 0,
      spawns: 0,
      settle: undefined as
        | { resolve: (v: { stdout: string }) => void; reject: (e: Error) => void }
        | undefined,
    };
    const run: BudgetedRun = () => {
      h.spawns++;
      return new Promise((resolve, reject) => {
        h.settle = { resolve, reject };
      });
    };
    const enrich = createCwdEnricher(run, () => h.t);
    return { h, enrich };
  }
  // Let the settled child's .then/.catch install its bookkeeping.
  const drain = () => Bun.sleep(0);
  // Ticks where pruning is irrelevant to the assertion (the served map is
  // empty) pass an empty live set — livePids is required, mirroring the
  // production call site.
  const noPids: ReadonlySet<number> = new Set();

  it("a slow run stretches the gap (GAP_FACTOR × duration); a fast run restores per-tick cadence", async () => {
    const { h, enrich } = harness();
    enrich(new Set([1])); // t=0: spawns
    expect(h.spawns).toBe(1);
    h.t = 14_000; // rasam-shaped run: 14s
    h.settle?.resolve({ stdout: "p1\nn/tmp\n" });
    await drain();
    // Next spawn allowed at 14s + 3×14s = 56s — ticks inside the gap serve
    // the stale map without a child.
    h.t = 55_999;
    expect(enrich(new Set([1])).get(1)).toBe("/tmp");
    expect(h.spawns).toBe(1);
    h.t = 56_000;
    enrich(new Set([1]));
    expect(h.spawns).toBe(2);
    // Recovery: this run is fast (300ms) → gap 0.9s → the next 2s tick spawns.
    h.t = 56_300;
    h.settle?.resolve({ stdout: "p1\nn/tmp\n" });
    await drain();
    h.t = 58_000;
    enrich(new Set([1]));
    expect(h.spawns).toBe(3);
  });

  it("consecutive failures back off exponentially, capped, and reset on success", async () => {
    const { h, enrich } = harness();
    const fail = async () => {
      h.settle?.reject(new Error("killed at budget"));
      await drain();
    };
    enrich(noPids); // t=0: spawn 1
    await fail(); // k=1 → gap 3×20s = 60s
    h.t = 59_999;
    enrich(noPids);
    expect(h.spawns).toBe(1);
    h.t = 60_000;
    enrich(noPids); // spawn 2
    expect(h.spawns).toBe(2);
    await fail(); // k=2 → gap 120s
    h.t = 179_999;
    enrich(noPids);
    expect(h.spawns).toBe(2);
    h.t = 180_000;
    enrich(noPids); // spawn 3
    await fail(); // k=3 → gap 240s
    h.t = 420_000;
    enrich(noPids); // spawn 4
    await fail(); // k=4 → 480s exceeds the 300s cap → gap 300s
    h.t = 719_999;
    enrich(noPids);
    expect(h.spawns).toBe(4);
    h.t = 720_000;
    enrich(noPids); // spawn 5
    expect(h.spawns).toBe(5);
    // First success resets the failure ladder: instant run → zero gap.
    h.settle?.resolve({ stdout: "" });
    await drain();
    h.t = 720_001;
    enrich(noPids);
    expect(h.spawns).toBe(6);
  });

  it("keeps serving the last-landed map through failures (stale beats blank)", async () => {
    const { h, enrich } = harness();
    enrich(new Set([42]));
    h.settle?.resolve({ stdout: "p42\nn/srv\n" });
    await drain();
    expect(enrich(new Set([42])).get(42)).toBe("/srv"); // also spawns run 2 (zero gap)
    h.settle?.reject(new Error("lsof gone"));
    await drain();
    // The failed run must not blank the map.
    expect(enrich(new Set([42])).get(42)).toBe("/srv");
  });

  it("caps the success gap so a pathological duration reading cannot starve enrichment past the backoff ceiling", async () => {
    const { h, enrich } = harness();
    enrich(noPids); // t=0: spawns
    // A laptop sleeping mid-run (or any clock pathology) reads as a huge
    // duration: 3×200s = 600s would exceed the 300s ceiling every other
    // path is bounded to — the cap must clamp it.
    h.t = 200_000;
    h.settle?.resolve({ stdout: "" });
    await drain();
    h.t = 200_000 + 299_999;
    enrich(noPids);
    expect(h.spawns).toBe(1);
    h.t = 200_000 + 300_000;
    enrich(noPids);
    expect(h.spawns).toBe(2);
  });

  it("routes a SYNCHRONOUSLY-throwing exec onto the failure backoff instead of wedging in-flight forever", async () => {
    let t = 0;
    let spawns = 0;
    const throwingRun: BudgetedRun = () => {
      spawns++;
      throw new Error("spawn failed sync");
    };
    const enrich = createCwdEnricher(throwingRun, () => t);
    expect(enrich(noPids).size).toBe(0); // must not throw out of the thunk
    await Bun.sleep(0);
    // Backoff scheduled (k=1 → 60s), then the enricher recovers to retry —
    // a wedged inFlight would spawn nothing ever again.
    t = 59_999;
    enrich(noPids);
    expect(spawns).toBe(1);
    t = 60_000;
    enrich(noPids);
    expect(spawns).toBe(2);
  });

  it("prunes dead pids from the served map so a recycled pid cannot inherit a stale cwd", async () => {
    const { h, enrich } = harness();
    enrich(new Set([42, 43]));
    h.settle?.resolve({ stdout: ["p42", "n/srv", "p43", "n/tmp", ""].join("\n") });
    await drain();
    // pid 42 died; this tick's live set no longer carries it.
    const served = enrich(new Set([43]));
    expect(served.has(42)).toBe(false);
    expect(served.get(43)).toBe("/tmp");
  });

  it("a slow landing cannot reintroduce a pid a later tick already observed dead", async () => {
    const { h, enrich } = harness();
    enrich(new Set([42, 43])); // spawn run 1 — 42 alive when it started
    // While the child is in flight, a later tick observes 42 ABSENT.
    enrich(new Set([43]));
    // The old child lands carrying the dead pid — the landing must be
    // filtered through the run's eligible set, or a pid recycled before
    // the next tick would inherit the dead process's cwd despite having
    // been observed dead (the documented one-tick blank bound).
    h.settle?.resolve({ stdout: ["p42", "n/srv", "p43", "n/tmp", ""].join("\n") });
    await drain();
    const served = enrich(new Set([42, 43])); // 42 recycled this tick
    expect(served.has(42)).toBe(false);
    expect(served.get(43)).toBe("/tmp");
  });

  it("an absence is permanent for the run: alive → observed-absent → recycled-live → old landing still blanks", async () => {
    const { h, enrich } = harness();
    enrich(new Set([42, 43])); // spawn run 1 — 42 alive at spawn
    enrich(new Set([43])); // 42 observed ABSENT mid-run
    // 42 is RECYCLED and reads live again BEFORE the old run lands — a
    // freshest-set-only intersect would forget the absence here and hand
    // the recycled pid the dead process's cwd.
    enrich(new Set([42, 43]));
    h.settle?.resolve({ stdout: ["p42", "n/srv", "p43", "n/tmp", ""].join("\n") });
    await drain();
    const served = enrich(new Set([42, 43]));
    expect(served.has(42)).toBe(false); // blank until the NEXT landed run
    expect(served.get(43)).toBe("/tmp");
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

describe("parseProcStat", () => {
  // proc(5) /proc/<pid>/stat: `pid (comm) state ppid … utime stime … nice
  // num_threads … starttime …`. After comm the fields index from state=0.
  const sample =
    "4242 (bash) S 1000 4242 4242 0 -1 4194560 100 0 5 0 56 12 0 0 20 5 7 0 987654 0 0";

  it("reads state, ppid, utime+stime ticks, nice, threads, and starttime", () => {
    const stat = parseProcStat(sample);
    expect(stat).not.toBeNull();
    expect(stat).toEqual({
      comm: "bash",
      state: "S",
      ppid: 1000,
      ticks: 56 + 12,
      nice: 5,
      threads: 7,
      startTime: 987654,
    });
  });

  it("splits on the LAST paren so a comm containing parens survives", () => {
    // Kernel comms like `(sd-pam)` or a renamed thread can embed parens; the
    // state/ppid that follow must still align.
    const stat = parseProcStat(
      "77 (foo (bar)) R 2 0 0 0 -1 0 0 0 0 0 1 2 0 0 20 0 3 0 555",
    );
    expect(stat?.comm).toBe("foo (bar)");
    expect(stat?.state).toBe("R");
    expect(stat?.ppid).toBe(2);
    expect(stat?.threads).toBe(3);
  });

  it("returns null when there is no comm paren to split on", () => {
    expect(parseProcStat("not a stat line")).toBeNull();
    expect(parseProcStat("")).toBeNull();
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
