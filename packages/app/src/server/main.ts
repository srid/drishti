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
 * Hosts come from:
 *   1. CLI positional args (`drishti host1 host2 ...`) — explicit
 *      override; writes through to the persisted file.
 *   2. The persisted file (`$XDG_STATE_HOME/drishti/hosts.json` or the
 *      override in `DRISHTI_HOSTS_FILE`) when no CLI args were passed.
 *   3. `["localhost"]` when neither is present.
 *
 * Admin-surface mutations (`addHost` / `removeHost`) persist back to the
 * same file so UI changes survive a restart.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { RPCHandler } from "@orpc/server/ws";
import { cli } from "cleye";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket as WsConn } from "ws";
import {
  destroyAllSessions,
  getHostSession,
  type HostSession,
} from "@kolu/surface-nix-host";
import { ADMIN_HOST_SENTINEL } from "../common/admin-surface";
import type { surface } from "../common/surface";
import { buildAdminRouter } from "./admin-router";
import { buildClient } from "./build";
import { loadHosts, resolveHostsFile, saveHosts } from "./hostsStore";
import { buildRouter } from "./router";

function log(line: string): void {
  process.stderr.write(`[server] ${line}\n`);
}

interface HostEntry {
  session: HostSession<typeof surface.contract>;
  // biome-ignore lint/suspicious/noExplicitAny: matches the existing router-handler cast (see implementSurface fragment shape).
  handler: RPCHandler<any>;
}

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
  const drvPath = process.env.DRISHTI_AGENT_DRV;
  if (drvPath === undefined || drvPath.length === 0) {
    log(
      "DRISHTI_AGENT_DRV is required (no fallback). Set it to the agent's .drv path — e.g. `DRISHTI_AGENT_DRV=$(nix eval --raw .#packages.<system>.drishti-agent.drvPath)`.",
    );
    process.exit(1);
  }
  log(`agent drv=${drvPath}`);

  const hostsFile = resolveHostsFile();
  const cliHosts = argv._.host;
  let hosts: string[];
  if (cliHosts.length > 0) {
    hosts = [...cliHosts];
    await saveHosts(hostsFile, hosts);
    log(`hosts from CLI (${hosts.length}): ${hosts.join(", ")}`);
  } else {
    const persisted = await loadHosts(hostsFile);
    hosts = persisted.length > 0 ? persisted : ["localhost"];
    if (persisted.length === 0) await saveHosts(hostsFile, hosts);
    log(
      `hosts from ${persisted.length > 0 ? `state file ${hostsFile}` : "default"} (${hosts.length}): ${hosts.join(", ")}`,
    );
  }

  const entries = new Map<string, HostEntry>();
  const wsConnectionsByHost = new Map<string, Set<WsConn>>();

  const buildEntry = (host: string): HostEntry => {
    const session = getHostSession<typeof surface.contract>({
      host,
      drvPath,
      binary: "drishti-agent",
    });
    const { router } = buildRouter({ session });
    // biome-ignore lint/suspicious/noExplicitAny: implementSurface's Lazy<Router> spread isn't accepted by oRPC's Router<any, T> input type; runtime shape is valid.
    const handler = new RPCHandler(router as any);
    return { session, handler };
  };

  for (const host of hosts) entries.set(host, buildEntry(host));

  // Admin handler — single source of truth for "which hosts exist". The
  // procedures call into closures over the host/socket maps so the same
  // boot-time setup (create session, register handler) runs whether a
  // host arrived via CLI args, the persisted file, or a UI add.
  const admin = buildAdminRouter({
    initialHosts: hosts,
    onAdd: async (host) => {
      if (entries.has(host)) throw new Error("host already exists");
      entries.set(host, buildEntry(host));
      await saveHosts(hostsFile, [...entries.keys()]);
      log(`added host: ${host} (total ${entries.size})`);
    },
    onRemove: async (host) => {
      const entry = entries.get(host);
      if (entry === undefined) return;
      // Boot the browsers off the removed host's WS. Their PartySocket
      // will retry, but the upgrade handler now rejects unknown hosts
      // — the destroyed socket stays destroyed.
      const sockets = wsConnectionsByHost.get(host);
      if (sockets !== undefined) {
        for (const ws of sockets) {
          try {
            ws.close(1000, "host removed");
          } catch {
            /* best-effort */
          }
        }
        wsConnectionsByHost.delete(host);
      }
      entry.session.destroy();
      entries.delete(host);
      await saveHosts(hostsFile, [...entries.keys()]);
      log(`removed host: ${host} (total ${entries.size})`);
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: see same cast above.
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

  // ── WebSocket: dispatch by `?host=<id>` query ──────────────────────
  // One `WebSocketServer` handles the protocol upgrade; the connection
  // handler picks the right per-host `RPCHandler` (or the admin one)
  // from the host parsed during upgrade. Mounting per-host handlers at
  // path segments (`/rpc/ws/<host>`) would make the path table volatile
  // as hosts come and go; query-param dispatch keeps it stable.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
  });

  wss.on("connection", (ws, req) => {
    const host = (req as { __host?: string }).__host;
    if (host === undefined) {
      ws.close(1008, "missing host");
      return;
    }
    if (host === ADMIN_HOST_SENTINEL) {
      log("browser ws connect (admin)");
      ws.on("close", (code, reason) =>
        log(
          `browser ws disconnect (admin) (code=${code} reason=${reason.toString() || "<none>"})`,
        ),
      );
      ws.on("error", (err) => log(`browser ws error (admin): ${err.message}`));
      void adminHandler.upgrade(
        ws as unknown as Parameters<typeof adminHandler.upgrade>[0],
      );
      return;
    }
    const entry = entries.get(host);
    if (entry === undefined) {
      ws.close(1008, `unknown host: ${host}`);
      return;
    }
    let sockets = wsConnectionsByHost.get(host);
    if (sockets === undefined) {
      sockets = new Set();
      wsConnectionsByHost.set(host, sockets);
    }
    sockets.add(ws);
    log(`browser ws connect (host=${host})`);
    ws.on("close", (code, reason) => {
      sockets.delete(ws);
      log(
        `browser ws disconnect (host=${host}) (code=${code} reason=${reason.toString() || "<none>"})`,
      );
    });
    ws.on("error", (err) => log(`browser ws error (host=${host}): ${err.message}`));
    void entry.handler.upgrade(
      ws as unknown as Parameters<typeof entry.handler.upgrade>[0],
    );
  });

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
    if (host !== ADMIN_HOST_SENTINEL && !entries.has(host)) {
      s.destroy();
      return;
    }
    (r as { __host?: string }).__host = host;
    wss.handleUpgrade(
      req as Parameters<typeof wss.handleUpgrade>[0],
      socket as Parameters<typeof wss.handleUpgrade>[1],
      head as Parameters<typeof wss.handleUpgrade>[2],
      (ws) => wss.emit("connection", ws, req),
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
  process.stderr.write(`[server] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
