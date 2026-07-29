/**
 * W2.7: router-level test imports the REAL buildAdminRouter.
 * A refused skew session projects its typed anomaly through real procedures;
 * deleting the procedure goes red.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import { buildAdminRouter } from "./admin-router";
import {
  type DrishtiConvergence,
  type HostPool,
  type HostSession,
} from "./hostRegistry";

function stubPool(args: {
  convergence: DrishtiConvergence | null;
  renew?: () => Promise<void>;
}): HostPool {
  let conv = args.convergence;
  const session = {
    convergence: () => conv,
    outcome: () => null,
    identity: () => ({
      stateRoot: "/tmp/state",
      contractVersion: "1.0",
      startedAt: 1,
      commit: "abc",
      buildId: "bld",
    }),
    preservation: { children: "die" as const },
    renew:
      args.renew ??
      (async () => {
        conv = null;
      }),
    onState: () => () => {},
    currentState: () =>
      ({
        phase: "disconnected",
        error: "refused",
        cause: "remote",
        log: [],
        sinceMs: 0,
        campaignEpoch: 0,
      }) as const,
    reconnect: () => {},
    recheck: () => {},
    destroy: async () => {},
  } as unknown as HostSession;

  return {
    has: (h: string) => h === "localhost",
    getSession: (h: string) => (h === "localhost" ? session : undefined),
    getHandler: () => undefined,
    hosts: () => ["localhost"],
    add: async () => {},
    remove: async () => {},
    reconnect: () => {},
    recheckAll: () => {},
    destroyAll: async () => {},
    subscribe: () => () => {},
    attachSocket: () => {},
    detachSocket: () => {},
  } as unknown as HostPool;
}

describe("buildAdminRouter convergence + renew (W2.7)", () => {
  it("projects standing refuse anomaly through real hosts.convergence procedure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admin-router-"));
    try {
      const anomaly: DrishtiConvergence = {
        kind: "cross-supervisor",
        drained: "ik-1" as never,
        observed: "ik-2" as never,
        running: {
          contractVersion: "1.0",
          build: { kind: "known", id: "x" },
        },
        detail: "foreign lineage reappeared after drain",
      };
      const pool = stubPool({ convergence: anomaly });
      const admin = buildAdminRouter({ pool });

      // Real buildAdminRouter procedures — invoke via oRPC `call`.
      // biome-ignore lint/suspicious/noExplicitAny: oRPC runtime router
      const hosts = (admin.router as any).surface.admin.hosts;
      expect(hosts.convergence).toBeDefined();
      expect(hosts.renew).toBeDefined();

      const projected = await call(hosts.convergence, { host: "localhost" });
      expect(projected).toEqual({
        anomaly: {
          kind: "cross-supervisor",
          detail: "foreign lineage reappeared after drain",
          drained: { kind: "instance", key: "ik-1" },
          observed: { kind: "instance", key: "ik-2" },
          running: {
            contractVersion: "1.0",
            build: { kind: "known", id: "x" },
          },
        },
      });

      const renewed = await call(hosts.renew, { host: "localhost" });
      expect(renewed).toEqual({ ok: true });

      const after = await call(hosts.convergence, { host: "localhost" });
      expect(after).toEqual({ anomaly: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unknown host returns null anomaly / renew error", async () => {
    const pool = stubPool({ convergence: null });
    const admin = buildAdminRouter({ pool });
    // biome-ignore lint/suspicious/noExplicitAny: oRPC runtime router
    const hosts = (admin.router as any).surface.admin.hosts;
    expect(await call(hosts.convergence, { host: "missing" })).toEqual({
      anomaly: null,
    });
    expect(await call(hosts.renew, { host: "missing" })).toEqual({
      ok: false,
      error: "host not found",
    });
  });

  it("daemonStatus projects identity + phase for a connected-style session", async () => {
    const pool = stubPool({
      convergence: {
        kind: "adopted-stale",
        detail: "budget",
        running: {
          contractVersion: "1.0",
          build: { kind: "known", id: "old" },
        },
        expected: {
          contractVersion: "1.0",
          build: { kind: "known", id: "new" },
        },
      },
    });
    const admin = buildAdminRouter({ pool });
    // biome-ignore lint/suspicious/noExplicitAny: oRPC runtime router
    const hosts = (admin.router as any).surface.admin.hosts;
    expect(hosts.daemonStatus).toBeDefined();
    const status = await call(hosts.daemonStatus, { host: "localhost" });
    expect(status.anomaly?.kind).toBe("adopted-stale");
    expect(status.anomaly?.running?.build).toEqual({
      kind: "known",
      id: "old",
    });
    expect(status.identity?.buildId).toBe("bld");
    expect(status.phase).toBe("disconnected");
  });

  it("skew-refused session: renew callable (W3.4 retained binding)", async () => {
    const anomaly: DrishtiConvergence = {
      kind: "skew-refused",
      running: {
        contractVersion: "2.0",
        build: { kind: "known", id: "run" },
      },
      expected: {
        contractVersion: "1.0",
        build: { kind: "known", id: "exp" },
      },
      detail: "contract skew refused",
    };
    let renewed = false;
    const pool = stubPool({
      convergence: anomaly,
      renew: async () => {
        renewed = true;
      },
    });
    const admin = buildAdminRouter({ pool });
    // biome-ignore lint/suspicious/noExplicitAny: oRPC runtime router
    const hosts = (admin.router as any).surface.admin.hosts;
    const projected = await call(hosts.convergence, { host: "localhost" });
    expect(projected).toEqual({
      anomaly: {
        kind: "skew-refused",
        detail: "contract skew refused",
        running: {
          contractVersion: "2.0",
          build: { kind: "known", id: "run" },
        },
        expected: {
          contractVersion: "1.0",
          build: { kind: "known", id: "exp" },
        },
      },
    });
    const r = await call(hosts.renew, { host: "localhost" });
    expect(r).toEqual({ ok: true });
    expect(renewed).toBe(true);
  });

  it("null-binding renew surfaces error (W3.4 mutation pin)", async () => {
    // Production HostSession.renew throws "is not bound" when activeCombined
    // is null. Admin router maps that to { ok: false, error }. Force-null of
    // the binding in production renew goes red on the real-pool e2e; this
    // router test pins the error shape for the same message.
    const pool = stubPool({
      convergence: {
        kind: "skew-refused",
        running: {
          contractVersion: "2.0",
          build: { kind: "known", id: "run" },
        },
        expected: {
          contractVersion: "1.0",
          build: { kind: "known", id: "exp" },
        },
        detail: "skew",
      },
      renew: async () => {
        throw new Error(
          "drishti agent is not bound — cannot drain (the daemon is unreachable)",
        );
      },
    });
    const admin = buildAdminRouter({ pool });
    // biome-ignore lint/suspicious/noExplicitAny: oRPC runtime router
    const hosts = (admin.router as any).surface.admin.hosts;
    const r = (await call(hosts.renew, { host: "localhost" })) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/is not bound/);
  });
});
