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
});
