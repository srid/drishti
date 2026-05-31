/**
 * drishti parent server (multi-host).
 *
 * Three-tier bridge, repeated N times — once per configured host:
 *
 *   browser  ─WS oRPC─▶  this server  ─stdio oRPC─▶  remote agent
 *
 * The browser opens one WebSocket per host (plus one for the admin
 * surface). Each connection lands at `/rpc/ws?host=<id>`; the upgrade
 * handler dispatches to a per-host `RPCHandler`, or to the admin handler
 * when `host=__admin__`. The per-host `surface` schema is unchanged —
 * host identity lives only at the transport layer.
 *
 * The `HostRegistry` is the single source of truth for "which hosts
 * exist". Boot seeds it from CLI args (if any), the persisted file (if
 * none and the file exists), or `["localhost"]` (default); admin-surface
 * `addHost` / `removeHost` mutations flow through the same registry,
 * which persists back to the same file so UI changes survive restart.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { RPCHandler } from "@orpc/server/ws";
import { cli } from "cleye";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { destroyAllSessions } from "@kolu/surface-nix-host";
import { ADMIN_HOST_SENTINEL } from "../common/admin-surface";
import { buildAdminRouter } from "./admin-router";
import { resolveDrvForHost } from "./archMap";
import { buildClient } from "./build";
import { buildHostRegistry } from "./hostRegistry";
import { loadHosts, resolveHostsFile, saveHosts } from "./hostsStore";
import { installStderrTimestamps, makeLogger } from "./log";

// Stamp every stderr line (drishti's, kolu's, and the forwarded remote
// agent's) with a timestamp before anything logs — the connection
// diagnostics are unreadable without a timeline.
installStderrTimestamps();

const log = makeLogger("server");

const argv = cli({
  name: "drishti",
  parameters: ["[host...]"],
  flags: {
    port: {
      type: Number,
      description: "HTTP+WebSocket port",
      default: Number(process.env.PORT ?? 7720),
    },
  },
});

async function main(): Promise<void> {
  const drvsJson = process.env.DRISHTI_AGENT_DRVS_JSON;
  if (drvsJson === undefined || drvsJson.length === 0) {
    log(
      "DRISHTI_AGENT_DRVS_JSON is required (no fallback). Set it to a JSON object mapping nix-system → agent .drv path — e.g. `DRISHTI_AGENT_DRVS_JSON=$(nix eval --raw .#agentDrvsJson)`. The monitor wrapper bakes this map from flake.nix.",
    );
    process.exit(1);
  }
  const drvMapSchema = z.record(z.string(), z.string().min(1));
  let agentDrvBySystem: Record<string, string>;
  try {
    agentDrvBySystem = drvMapSchema.parse(JSON.parse(drvsJson));
  } catch (err) {
    log(`DRISHTI_AGENT_DRVS_JSON: invalid — ${(err as Error).message}`);
    process.exit(1);
  }
  log(
    `agent drvs (${Object.keys(agentDrvBySystem).length}): ${Object.keys(agentDrvBySystem).join(", ")}`,
  );

  const resolveDrvPath = (host: string): Promise<string> =>
    resolveDrvForHost(host, agentDrvBySystem);

  const hostsFile = resolveHostsFile();
  const cliHosts = argv._.host;
  let initialHosts: string[];
  if (cliHosts.length > 0) {
    initialHosts = [...cliHosts];
    await saveHosts(hostsFile, initialHosts);
    log(
      `hosts from CLI (${initialHosts.length}): ${initialHosts.join(", ")}`,
    );
  } else {
    const persisted = await loadHosts(hostsFile);
    initialHosts = persisted.length > 0 ? persisted : ["localhost"];
    if (persisted.length === 0) await saveHosts(hostsFile, initialHosts);
    log(
      `hosts from ${persisted.length > 0 ? `state file ${hostsFile}` : "default"} (${initialHosts.length}): ${initialHosts.join(", ")}`,
    );
  }

  const registry = await buildHostRegistry({
    initialHosts,
    resolveDrvPath,
    hostsFile,
    log,
  });

  const admin = buildAdminRouter({ registry });
  // biome-ignore lint/suspicious/noExplicitAny: matches existing router-handler cast (see implementSurface fragment shape).
  const adminHandler = new RPCHandler(admin.router as any);

  // ── HTTP server: serve the client bundle ──────────────────────────
  const distDir = process.env.DRISHTI_DIST_DIR
    ? process.env.DRISHTI_DIST_DIR
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
  if (!process.env.DRISHTI_DIST_DIR) {
    log(`building client bundle into ${distDir}`);
    await buildClient(distDir);
  } else {
    if (!(await Bun.file(resolve(distDir, "index.html")).exists())) {
      log(
        `DRISHTI_DIST_DIR=${distDir} is set but index.html is missing — the wrapper points at an unbuilt dist.`,
      );
      process.exit(1);
    }
    log(`serving prebuilt client bundle from ${distDir}`);
  }
  const app = new Hono();
  // serveStatic serves the whole dist tree, including the PWA assets. It
  // already maps `.webmanifest` to `application/manifest+json` (via
  // hono/utils/mime), so the manifest needs no special-casing here.
  app.use("*", serveStatic({ root: distDir }));

  const httpServer = serve(
    {
      fetch: app.fetch,
      port: argv.flags.port,
      hostname: "0.0.0.0",
    },
    (info) => {
      log(
        `listening on http://${info.address}:${info.port} (open http://localhost:${info.port}/)`,
      );
    },
  );

  // ── WebSocket: one server, dispatch by `?host=<id>` query ────────────
  // Mounting per-host handlers at path segments (`/rpc/ws/<host>`) would
  // make the routing table volatile as hosts come and go; query-param
  // dispatch keeps it stable. The parsed `host` is closed over in the
  // handleUpgrade callback — no need to store it on the request object.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
  });

  // ── WebSocket upgrade: parse ?host=<id>, then dispatch directly ──────
  // The `host` variable is closed over in the handleUpgrade callback so
  // there is no need to taint the IncomingMessage object with __host.
  (
    httpServer as unknown as {
      on: (
        event: "upgrade",
        cb: (req: unknown, socket: unknown, head: unknown) => void,
      ) => void;
    }
  ).on("upgrade", (req, socket, head) => {
    const r = req as { url?: string };
    const s = socket as { destroy: () => void };
    if (r.url === undefined) {
      s.destroy();
      return;
    }
    const url = new URL(r.url, "ws://localhost");
    if (url.pathname !== "/rpc/ws") {
      s.destroy();
      return;
    }
    const host = url.searchParams.get("host");
    if (host === null || host.length === 0) {
      s.destroy();
      return;
    }
    if (host !== ADMIN_HOST_SENTINEL && !registry.has(host)) {
      s.destroy();
      return;
    }
    wss.handleUpgrade(
      req as Parameters<typeof wss.handleUpgrade>[0],
      socket as Parameters<typeof wss.handleUpgrade>[1],
      head as Parameters<typeof wss.handleUpgrade>[2],
      (ws) => {
        if (host === ADMIN_HOST_SENTINEL) {
          log("browser ws connect (admin)");
          ws.on("close", (code, reason) =>
            log(
              `browser ws disconnect (admin) (code=${code} reason=${reason.toString() || "<none>"})`,
            ),
          );
          ws.on("error", (err) =>
            log(`browser ws error (admin): ${err.message}`),
          );
          void adminHandler.upgrade(
            ws as unknown as Parameters<typeof adminHandler.upgrade>[0],
          );
          return;
        }
        const handler = registry.getHandler(host);
        if (handler === undefined) {
          ws.close(1008, `unknown host: ${host}`);
          return;
        }
        registry.registerConnection(host, ws);
        log(`browser ws connect (host=${host})`);
        ws.on("close", (code, reason) => {
          registry.unregisterConnection(host, ws);
          log(
            `browser ws disconnect (host=${host}) (code=${code} reason=${reason.toString() || "<none>"})`,
          );
        });
        ws.on("error", (err) =>
          log(`browser ws error (host=${host}): ${err.message}`),
        );
        void handler.upgrade(
          ws as unknown as Parameters<typeof handler.upgrade>[0],
        );
      },
    );
  });

  const shutdown = (sig: string) => {
    log(`${sig}: destroying host sessions`);
    destroyAllSessions();
    wss.close();
    for (const ws of wss.clients) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
    const srv = httpServer as unknown as {
      closeAllConnections?: () => void;
      close: (cb?: () => void) => void;
    };
    srv.closeAllConnections?.();
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
