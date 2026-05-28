/**
 * drishti parent server.
 *
 * Three-tier bridge:
 *
 *   browser  ─WS oRPC─▶  this server  ─stdio oRPC─▶  remote agent
 *
 * Browser ↔ server uses oRPC over WebSocket (`@orpc/server/ws`). Server
 * ↔ agent uses a stdio link via `HostSession` from `@kolu/surface-nix-host`.
 *
 * Configuration (env vars):
 *
 *   HOST (or first positional arg)  ssh target (default: localhost)
 *   DRISHTI_AGENT_DRV (required) path to the agent's `.drv`; the
 *                                 derivation is shipped to the target
 *                                 host and realised there for the right
 *                                 architecture. **No fallback** — the
 *                                 operator names this explicitly.
 *   PORT                          HTTP+WS port (default 7720)
 *   DRISHTI_DIST_DIR             when set, serve the pre-built client
 *                                 bundle from this dir (production mode)
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { RPCHandler } from "@orpc/server/ws";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { destroyAllSessions, getHostSession } from "@kolu/surface-nix-host";
import type { surface } from "../common/surface";
import { buildClient } from "./build";
import { buildRouter } from "./router";

const HOST = process.argv[2] ?? process.env.HOST ?? "localhost";
const DRV_PATH = process.env.DRISHTI_AGENT_DRV;
const PORT = Number(process.env.PORT ?? 7720);

/** Tag every parent-side log so `[server]` lines are visually distinct
 *  from `[host:<h> local]` (HostSession) and `[host:<h> remote]`
 *  (forwarded agent stderr). */
function log(line: string): void {
  process.stderr.write(`[server] ${line}\n`);
}

async function main(): Promise<void> {
  if (DRV_PATH === undefined || DRV_PATH.length === 0) {
    log(
      "DRISHTI_AGENT_DRV is required (no fallback). Set it to the agent's .drv path — e.g. `DRISHTI_AGENT_DRV=$(nix eval --raw .#packages.<system>.drishti-agent.drvPath)`.",
    );
    process.exit(1);
  }
  log(`host=${HOST}, agent drv=${DRV_PATH}`);

  const session = getHostSession<typeof surface.contract>({
    host: HOST,
    drvPath: DRV_PATH,
    binary: "drishti-agent",
  });
  const { router } = buildRouter({ session });

  // ── HTTP server: serve the client bundle ──────────────────────────
  // Either "use this pre-built dist" (production / `nix run`) or "build
  // into this writable path" (dev). The env var is the sole adapter;
  // the rest of the server treats `distDir` uniformly.
  const distDir = process.env.DRISHTI_DIST_DIR
    ? process.env.DRISHTI_DIST_DIR
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
  if (!process.env.DRISHTI_DIST_DIR) {
    log(`building client bundle into ${distDir}`);
    await buildClient(distDir);
  } else {
    // Fail loud at startup if the wrapper points at a directory missing
    // the built dist — without this assertion, `serveStatic` on a
    // missing path would silently 404 every request.
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
      port: PORT,
      hostname: "0.0.0.0",
    },
    (info) => {
      log(
        `listening on http://${info.address}:${info.port} (open http://localhost:${info.port}/)`,
      );
    },
  );

  // ── WebSocket: oRPC over @orpc/server/ws ───────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: implementSurface's Lazy<Router> spread isn't accepted by oRPC's Router<any, T> input type; runtime shape is valid.
  const wsHandler = new RPCHandler(router as any);
  const wss = new WebSocketServer({
    noServer: true,
    // 8 MiB per inbound frame — the processes-collection cold-start
    // sends a ~600-item key array in a single frame, comfortably under
    // 1 MiB; raise the cap so we can't quietly hit it as the demo scales.
    maxPayload: 8 * 1024 * 1024,
  });
  wss.on("connection", (ws) => {
    log("browser ws connect");
    ws.on("close", (code, reason) =>
      log(
        `browser ws disconnect (code=${code} reason=${reason.toString() || "<none>"})`,
      ),
    );
    ws.on("error", (err) => log(`browser ws error: ${err.message}`));
    void wsHandler.upgrade(
      ws as unknown as Parameters<typeof wsHandler.upgrade>[0],
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
    if (r.url !== "/rpc/ws") {
      s.destroy();
      return;
    }
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
    // `httpServer.close()` waits for in-flight connections to drain. The
    // browser's WebSocket is long-lived — it never closes on its own —
    // so Ctrl+C hangs forever without forcing connections shut.
    // `closeAllConnections()` (Node ≥ 18.2) kills sockets immediately.
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
    // Belt-and-braces: if close() still hangs (unexpected stuck socket),
    // exit forcibly after a short grace window.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[server] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
