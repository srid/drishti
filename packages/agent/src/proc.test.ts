import { describe, expect, it } from "bun:test";
import { osfactsSourceStatus } from "drishti-common/source-errors";
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
  "C\t42\t1000000",
  "UID\t1\t0",
  "UID\t42\t1000",
  'CWD\t42\t"/srv/app"',
  "STAT\t1\tS\t0\t-",
  "STAT\t42\tR\t5\t8",
  'ARGV\t42\t["/usr/bin/server","--listen","8080"]',
  "L\tclaimed\t42\t1000\t8080\t00000000",
  "L\tunclaimed\t-\t81\t22\t00000000",
  "U\t42\tports\tEACCES",
  "U\t99\tproc\tEPERM",
  "U\t99\tcwd\tEACCES",
  "",
].join("\n");

const hostFixture = [
  "V\t2",
  "HLOAD\t1.25\t0.75\t0.5",
  "HMEM\t10000\t4000",
  "HSWAP\t2000\t500",
  "HUP\t123000000",
  'HCPU\t0\t100\t50\t850\t0\t"Test CPU"\t2400',
  'HCPU\t1\t200\t100\t700\t0\t"Test CPU"\t2400',
  "HNET\tlo\t100\t100",
  "HNET\teth0\t1000\t2000",
  "HDISK\t/\t20000\t8000\t7000",
  "",
].join("\n");

describe("osfacts V2 process observation", () => {
  it("maps RSS, start identity, facet errors and claimed/unclaimed listeners", () => {
    const frame = processesFromOsfacts(parseOsfactsOutput(snapshotFixture));
    expect(frame.processes.get(42)).toEqual({
      name: "server",
      command: "/usr/bin/server --listen 8080",
      cpuPct: 0,
      user: "1000",
      cwd: "/srv/app",
      state: "R",
      nice: 5,
      threads: 8,
      ppid: 1,
      rssBytes: 8192,
      startedAtMs: 1700000000123.456,
      listeners: [{ uid: 1000, port: 8080, address: "00000000" }],
      unreadable: [{ facet: "ports", errno: "EACCES" }],
    });
    expect(frame.processes.get(99)).toEqual({
      name: "",
      command: "",
      cpuPct: 0,
      user: "",
      cwd: null,
      state: null,
      nice: null,
      threads: null,
      ppid: 0,
      rssBytes: null,
      startedAtMs: null,
      listeners: [],
      unreadable: [
        { facet: "proc", errno: "EPERM" },
        { facet: "cwd", errno: "EACCES" },
      ],
    });
    expect([...frame.unclaimedListeners.values()]).toEqual([
      { uid: 81, port: 22, address: "00000000" },
    ]);
    expect(frame.processes.get(1)?.user).toBe("root");
    expect(frame.processes.get(1)?.threads).toBeNull();
  });

  it("derives process CPU percent by diffing cumulative CPU time between polls", async () => {
    const readings = [
      parseOsfactsOutput("V\t2\nP\t42\t1\tserver\nC\t42\t1000000\n"),
      parseOsfactsOutput("V\t2\nP\t42\t1\tserver\nC\t42\t1500000\n"),
    ];
    let index = 0;
    let clock = 1_000;
    const reader = createOsfactsReader(
      "/nix/store/osfacts/bin/osfacts",
      "linux",
      "test",
      async () => readings[index++]!,
      async () => parseOsfactsOutput(hostFixture),
      () => clock,
    );
    expect((await reader.readProcesses()).get(42)?.cpuPct).toBe(0);
    clock = 2_001;
    expect((await reader.readProcesses()).get(42)?.cpuPct).toBe(50);
  });

  it("keeps the compact name while restoring argv with the historic 200-char cap", () => {
    const argument = "x".repeat(220);
    const reading = parseOsfactsOutput(
      `V\t2\nP\t42\t1\tserver\nARGV\t42\t${JSON.stringify(["/usr/bin/server", argument])}\n`,
    );
    const process = processesFromOsfacts(reading).processes.get(42)!;
    expect(process.name).toBe("server");
    expect(process.command).toHaveLength(200);
    expect(process.command.endsWith("…")).toBe(true);
  });

  it("requests every OSF3/OSF6 facet and shares one atomic snapshot", async () => {
    const calls: unknown[] = [];
    const reading = parseOsfactsOutput(snapshotFixture);
    const hostReading = parseOsfactsOutput(hostFixture);
    const reader = createOsfactsReader(
      "/nix/store/osfacts/bin/osfacts",
      "linux",
      "test",
      async (bin, facets) => {
        calls.push({ bin, facets });
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
        facets: {
          procs: true,
          ports: true,
          mem: true,
          startTime: true,
          cpuTime: true,
          uid: true,
          cwd: true,
          status: true,
          argv: true,
        },
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

  it("includes the host-wide Linux kernel-thread row", async () => {
    const reader = createProcReader();
    if (reader.os !== "linux") return;
    expect((await reader.readProcesses()).get(2)?.name).toBe("kthreadd");
  });

  it("publishes surviving facts and carries partial-source status", () => {
    const reading = parseOsfactsOutput(
      "V\t2\nP\t42\t1\tserver\nE\tports\tBLIND_OR_EMPTY\n",
    );
    const frame = processesFromOsfacts(reading);
    expect(frame.processes.get(42)?.command).toBe("server");
    expect(frame.sourceErrors).toEqual([
      { operation: "snapshot", source: "ports", code: "BLIND_OR_EMPTY" },
    ]);
  });

  it("exposes partial errors on the status collection without rejecting facts", async () => {
    const reading = parseOsfactsOutput(
      "V\t2\nP\t42\t1\tserver\nE\tports\tBLIND_OR_EMPTY\n",
    );
    const reader = createOsfactsReader(
      "/nix/store/osfacts/bin/osfacts",
      "linux",
      "test",
      async () => reading,
      async () => parseOsfactsOutput(hostFixture),
      () => 10,
    );
    expect((await reader.readProcesses()).has(42)).toBe(true);
    expect([...(await reader.readSourceErrors()).values()]).toEqual([
      { operation: "snapshot", source: "ports", code: "BLIND_OR_EMPTY" },
    ]);
  });
});

describe("osfacts V2 host observation", () => {
  it("preserves a source-error row as structured failure status", () => {
    let rejection: unknown;
    try {
      hostFromOsfacts(
        parseOsfactsOutput("V\t2\nE\tdisk\tBLIND_OR_EMPTY\n"),
        undefined,
        1_000,
        "linux",
        "zest",
      );
    } catch (error) {
      rejection = error;
    }
    expect(osfactsSourceStatus(rejection)).toEqual({
      operation: "host",
      errors: [{ source: "disk", code: "BLIND_OR_EMPTY" }],
    });
  });

  it("publishes a complete host aggregate with an accompanying source error", () => {
    const reading = parseOsfactsOutput(
      `${hostFixture}E\tthermal\tUNSUPPORTED\n`,
    );
    const mapped = hostFromOsfacts(
      reading,
      undefined,
      1_000,
      "linux",
      "zest",
    );
    expect(mapped.frame.system.hostname).toBe("zest");
    expect(mapped.frame.sourceErrors).toEqual([
      { operation: "host", source: "thermal", code: "UNSUPPORTED" },
    ]);
  });

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
      diskUsed: 13000,
      diskTotal: 20000,
      uptime: 123,
      os: "linux",
      hostname: "zest",
    });
    expect(mapped.frame.cpuCores.get(0)).toEqual({
      usagePct: 0,
      model: "Test CPU",
      speedMHz: 2400,
    });
    expect(mapped.frame.networkInterfaces.get("eth0")).toEqual({
      rxBytes: 1000,
      txBytes: 2000,
      rxRate: 0,
      txRate: 0,
    });
    expect(mapped.frame.networkInterfaces.has("lo")).toBe(false);
  });

  it("keeps an honestly absent Apple Silicon clock nullable", () => {
    const reading = parseOsfactsOutput(
      hostFixture.replaceAll("\t2400", "\t-"),
    );
    expect(
      hostFromOsfacts(reading, undefined, 1_000, "darwin", "mac").frame
        .cpuCores.get(0)?.speedMHz,
    ).toBeNull();
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
      [
        0,
        {
          userUs: 100,
          systemUs: 100,
          idleUs: 800,
          otherUs: 0,
          model: "Test CPU",
          frequencyMhz: 2400,
        },
      ],
    ]);
    const current = new Map([
      [
        0,
        {
          userUs: 200,
          systemUs: 150,
          idleUs: 850,
          otherUs: 0,
          model: "Test CPU",
          frequencyMhz: 2400,
        },
      ],
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
