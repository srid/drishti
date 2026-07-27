import { describe, expect, it } from "bun:test";
import { parseOsfactsOutput } from "osfacts-client";
import {
  computeCpuUsage,
  computeNetThroughput,
  createOsfactsReader,
  createProcReader,
  hostFromOsfacts,
  processesFromOsfacts,
} from "./proc";

const snapshotFixture = [
  "V\t2",
  "P\t1\t0\tinit",
  "P\t42\t1\tserver",
  "M\t42\t8192",
  "S\t42\t1700000000123456",
  "L\tclaimed\t42\t1000\t8080\t00000000",
  "L\tunclaimed\t-\t81\t22\t00000000",
  "U\t42\tports\tEACCES",
  "U\t99\tproc\tEPERM",
  "",
].join("\n");

const hostFixture = [
  "V\t2",
  "HLOAD\t1.25\t0.75\t0.5",
  "HMEM\t10000\t4000",
  "HSWAP\t2000\t500",
  "HUP\t123000000",
  "HCPU\t0\t100\t50\t850\t0",
  "HCPU\t1\t200\t100\t700\t0",
  "HNET\tlo\t100\t100",
  "HNET\teth0\t1000\t2000",
  "HDISK\t/\t20000\t8000",
  "",
].join("\n");

describe("osfacts V2 process observation", () => {
  it("maps RSS, start identity, facet errors and claimed/unclaimed listeners", () => {
    const frame = processesFromOsfacts(parseOsfactsOutput(snapshotFixture));
    expect(frame.processes.get(42)).toEqual({
      command: "server",
      ppid: 1,
      rssBytes: 8192,
      startedAtMs: 1700000000123.456,
      listeners: [{ port: 8080, address: "00000000" }],
      unreadable: [{ facet: "ports", errno: "EACCES" }],
    });
    expect(frame.processes.get(99)).toEqual({
      command: "",
      ppid: 0,
      rssBytes: null,
      startedAtMs: null,
      listeners: [],
      unreadable: [{ facet: "proc", errno: "EPERM" }],
    });
    expect([...frame.unclaimedListeners.values()]).toEqual([
      { uid: 81, port: 22, address: "00000000" },
    ]);
  });

  it("requests every OSF3/OSF6 facet and shares one atomic snapshot", async () => {
    const calls: unknown[] = [];
    const reading = parseOsfactsOutput(snapshotFixture);
    const hostReading = parseOsfactsOutput(hostFixture);
    const reader = createOsfactsReader(
      "/nix/store/osfacts/bin/osfacts",
      "linux",
      "test",
      async (bin, roots, facets) => {
        calls.push({ bin, roots, facets });
        return reading;
      },
      async () => hostReading,
      () => 10,
    );
    await Promise.all([
      reader.readProcesses(),
      reader.readUnclaimedListeners(),
    ]);
    expect(calls).toEqual([
      {
        bin: "/nix/store/osfacts/bin/osfacts",
        roots: [1],
        facets: { procs: true, ports: true, mem: true, startTime: true },
      },
    ]);
  });

  it("keeps listener observation when pid attribution is permission-blind", async () => {
    const reader = createProcReader();
    if (reader.os !== "linux") return;
    const [processes, unclaimed] = await Promise.all([
      reader.readProcesses(),
      reader.readUnclaimedListeners(),
    ]);
    const blind = [...processes.values()].filter((process) =>
      process.unreadable.some(
        ({ facet, errno }) =>
          facet === "ports" && (errno === "EACCES" || errno === "EPERM"),
      ),
    );
    // Normal-user Linux CI/deployments exercise the production regression.
    // Privileged runners can have no blind pids, in which case there is no
    // permission loss for OSF6 to compensate for.
    if (blind.length > 0) expect(unclaimed.size).toBeGreaterThan(0);
  });

  it("rejects explicit partial-source failures instead of publishing a lie", () => {
    const reading = parseOsfactsOutput("V\t2\nE\tports\tBLIND_OR_EMPTY\n");
    expect(() => processesFromOsfacts(reading)).toThrow("ports:BLIND_OR_EMPTY");
  });
});

describe("osfacts V2 host observation", () => {
  it("maps all OSF7 host facts without native platform readers", () => {
    const mapped = hostFromOsfacts(
      parseOsfactsOutput(hostFixture),
      undefined,
      1_000,
      "linux",
      "zest",
    );
    expect(mapped.frame.system).toEqual({
      loadAvg: [1.25, 0.75, 0.5],
      memUsed: 6000,
      memTotal: 10000,
      swapUsed: 500,
      swapTotal: 2000,
      diskUsed: 12000,
      diskTotal: 20000,
      uptime: 123,
      os: "linux",
      hostname: "zest",
    });
    expect(mapped.frame.cpuCores.get(0)?.usagePct).toBe(0);
    expect(mapped.frame.networkInterfaces.get("eth0")).toEqual({
      rxBytes: 1000,
      txBytes: 2000,
      rxRate: 0,
      txRate: 0,
    });
    expect(mapped.frame.networkInterfaces.has("lo")).toBe(false);
  });

  it("shares one host call across system, CPU and network projections", async () => {
    let calls = 0;
    const reader = createOsfactsReader(
      "/nix/store/osfacts/bin/osfacts",
      "linux",
      "test",
      async () => parseOsfactsOutput(snapshotFixture),
      async (_bin, facets) => {
        calls++;
        expect(facets).toEqual({
          load: true,
          mem: true,
          cpu: true,
          net: true,
          disk: true,
        });
        return parseOsfactsOutput(hostFixture);
      },
      () => 10,
    );
    await Promise.all([
      reader.readSystem(),
      reader.readCpuCores(),
      reader.readNetwork(),
    ]);
    expect(calls).toBe(1);
  });
});

describe("cumulative counter projections", () => {
  it("derives CPU busy percentage from V2 cumulative microseconds", () => {
    const previous = new Map([
      [0, { userUs: 100, systemUs: 100, idleUs: 800, otherUs: 0 }],
    ]);
    const current = new Map([
      [0, { userUs: 200, systemUs: 150, idleUs: 850, otherUs: 0 }],
    ]);
    expect(computeCpuUsage(previous, current).get(0)?.usagePct).toBe(75);
  });

  it("derives network rates and clamps reset counters", () => {
    const previous = new Map([
      ["eth0", { rxBytes: 1000, txBytes: 2000 }],
    ]);
    expect(
      computeNetThroughput(
        previous,
        new Map([["eth0", { rxBytes: 1200, txBytes: 1900 }]]),
        2,
      ).get("eth0"),
    ).toEqual({ rxBytes: 1200, txBytes: 1900, rxRate: 100, txRate: 0 });
  });
});
