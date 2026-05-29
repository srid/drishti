import { describe, expect, it } from "bun:test";
import {
  computeNetThroughput,
  type NetCounters,
  parseNetstatIb,
  parseProcNetDev,
  parsePsLine,
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
  // `ps -axo pid=,user=,pcpu=,rss=,comm=` — rss is in KB on macOS,
  // comm is last/greedy (may contain spaces).
  it("parses rss (KB) into absolute resident bytes", () => {
    const parsed = parsePsLine("  501 alice 12.5 348160 /usr/bin/foo");
    expect(parsed).not.toBeNull();
    const [pid, proc] = parsed!;
    expect(pid).toBe(501);
    expect(proc.user).toBe("alice");
    expect(proc.cpuPct).toBe(12.5);
    // 348160 KB × 1024 = absolute bytes (≈ 356 MB).
    expect(proc.rssBytes).toBe(348160 * 1024);
    expect(proc.command).toBe("/usr/bin/foo");
    expect(proc.cwd).toBe("");
  });

  it("keeps a command with embedded spaces intact (comm is the trailing field)", () => {
    const [, proc] = parsePsLine("99 root 0.0 2048 com.apple.Some Helper")!;
    expect(proc.command).toBe("com.apple.Some Helper");
    expect(proc.rssBytes).toBe(2048 * 1024);
  });

  it("returns null for blank or malformed lines", () => {
    expect(parsePsLine("")).toBeNull();
    expect(parsePsLine("   ")).toBeNull();
    expect(parsePsLine("not a ps line")).toBeNull();
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
