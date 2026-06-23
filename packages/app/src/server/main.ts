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

import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { RPCHandler } from "@orpc/server/ws";
import { cli } from "cleye";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { destroyAllSessions } from "@kolu/surface-nix-host";
import { gateWsOrigin, parseAllowedOrigins } from "@kolu/surface/ws-origin";
import {
  acceptSurfaceSocket,
  installSurfaceApp,
} from "@kolu/surface-app/server";
import { ADMIN_HOST_SENTINEL, isValidHost } from "../common/host";
import { BRAND_DARK } from "../client/brand";
import { appNameForHost } from "../client/title";
import { buildAdminRouter } from "./admin-router";
import { resolveDrvForHost } from "./archMap";
import { buildClient } from "./build";
import { buildHostRegistry } from "./hostRegistry";
import { loadHosts, resolveHostsFile, saveHosts } from "./hostsStore";
import { installStderrTimestamps, makeLogger } from "./log";
import { startWakeMonitor } from "./wakeMonitor";

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
    bind: {
      type: String,
      description:
        "Network interface to bind (default 127.0.0.1, loopback-only). Set 0.0.0.0 to expose on all interfaces — the RPC surface is UNAUTHENTICATED, so only do this behind a firewall or a trusted proxy. Env: DRISHTI_BIND.",
      default: process.env.DRISHTI_BIND ?? "127.0.0.1",
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
  // Validate CLI host args at the same boundary as the admin surface and the
  // persisted file — a host that ssh would parse as an option must never
  // reach the spawn, whatever channel it arrived on. Fail fast and loud.
  const badCliHost = cliHosts.find((h) => !isValidHost(h));
  if (badCliHost !== undefined) {
    log(
      `invalid host argument ${JSON.stringify(badCliHost)} — a host must be non-empty, contain no whitespace, and not start with '-' (a leading '-' is parsed by ssh as an option). Aborting.`,
    );
    process.exit(1);
  }
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
  });

  const admin = buildAdminRouter({ registry });
  // biome-ignore lint/suspicious/noExplicitAny: matches existing router-handler cast (see implementSurface fragment shape).
  const adminHandler = new RPCHandler(admin.router as any);

  // Laptops sleep. On resume every ssh link is stale (the far end dropped
  // the socket while we were frozen); without a nudge the parent waits
  // ~30s for each ssh keepalive to notice. Detect the wake and re-probe
  // the whole fleet at once. The timer is unref'd, so this never keeps the
  // process alive on its own.
  const stopWakeMonitor = startWakeMonitor({
    onWake: (gapMs) => {
      log(
        `wake detected (process suspended ~${Math.round(gapMs / 1000)}s) — rechecking all host links`,
      );
      registry.recheckAll();
    },
  });

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
  // surface-app owns the freshness contract on the wire (the four-times-
  // relitigated stale-client bug): the no-store SPA shell, immutable hashed
  // `/assets/*`, a 404 (never the HTML shell) on an asset miss, the dynamic
  // PWA manifest, and the self-destructing `/sw.js` that retires the legacy
  // caching worker earlier drishti builds registered. One call replaces the
  // bare `serveStatic` mount that set no cache headers at all.
  //
  // Registered AFTER the `/rpc/ws` upgrade is wired below — but order is moot
  // here: drishti's WebSocket lives on the raw `httpServer.on("upgrade")`
  // handler, not in this Hono app, so this static catch-all only sees HTTP and
  // must simply be the app's last route (it is — nothing is mounted after it).
  // The app's identity is the host this drishti runs on — `drishti@<host>`.
  // Baking the server's own hostname into the manifest's name/short_name/id
  // makes each deployment a distinct, separately-labelled installable PWA
  // (install drishti from `zest` and from `rasam` and they don't collapse into
  // one "drishti" in the OS app list), and the client reads `short_name` back
  // for the matching tab title.
  const appName = appNameForHost(hostname());
  installSurfaceApp(app, {
    clientDist: distDir,
    manifest: {
      name: appName,
      short_name: appName,
      themeColor: BRAND_DARK,
      backgroundColor: BRAND_DARK,
      description:
        "htop for your whole fleet — live processes, CPU, memory, and network over SSH, with nothing installed on the remote.",
      id: `/?app=${encodeURIComponent(appName)}`,
      scope: "/",
      orientation: "any",
      icons: [
        { src: "/icons/icon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
        { src: "/icons/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
        { src: "/icons/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
        { src: "/icons/icon-maskable-512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
      ],
    },
  });

  // Loopback by default: the RPC surface is unauthenticated, so binding all
  // interfaces would hand any LAN neighbor the admin control plane (read
  // fleet metrics, add ssh hosts). Operators opt into wider exposure with
  // `--bind 0.0.0.0` (behind a firewall/proxy) and may allowlist extra
  // browser origins via `DRISHTI_ALLOWED_ORIGINS` for the reverse-proxy case.
  const bindHost = argv.flags.bind;
  const allowedOrigins = parseAllowedOrigins(
    process.env.DRISHTI_ALLOWED_ORIGINS,
  );

  const httpServer = serve(
    {
      fetch: app.fetch,
      port: argv.flags.port,
      hostname: bindHost,
    },
    (info) => {
      log(`listening on http://${info.address}:${info.port}`);
      if (["127.0.0.1", "localhost", "::1"].includes(bindHost)) {
        log(`open http://localhost:${info.port}/`);
      } else {
        log(
          `WARNING: bound to ${bindHost} (not loopback) — the RPC surface is unauthenticated; anyone who can reach this port can read fleet metrics and add ssh hosts. Prefer the default 127.0.0.1 unless this port is firewalled or behind a trusted proxy.`,
        );
      }
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

  // Acceptance seam (@kolu/surface-app, kolu#1545): `acceptSurfaceSocket` owns the
  // liveness reaper AND sequences stale-gate → enrol → dispatch in one
  // `accept(ws, requestUrl, onAccepted)` call. The reaper pings accepted sockets
  // and terminates any that stop ponging, reaping the server-side zombie a
  // half-open browser (laptop sleep, Wi-Fi roam, a NAT/proxy dropping an idle
  // connection) would otherwise leak — covering BOTH the admin control-plane
  // socket and every per-host socket. `liveProcessId` is the id the
  // `identity.info` probe reports, so the stale-tab gate and the probe
  // single-source. `onError`/`onReject` receive the upgrade `requestUrl` so we
  // re-derive `?host=` for the per-host log line. The browser's own recovery is
  // automatic: the admin socket rides `<SurfaceAppProvider>`'s turnkey source,
  // which starts a `createHeartbeat` watchdog itself; the per-host sockets now
  // carry `connectSurface`'s default-on watchdog (see client/wire.ts).
  const acceptor = acceptSurfaceSocket({
    server: wss,
    liveProcessId: admin.processId,
    onError: (err, url) =>
      log(`browser ws error (host=${url.searchParams.get("host")}): ${err.message}`),
    onReject: (_pid, url) =>
      log(
        `rejecting stale browser ws (host=${url.searchParams.get("host")}) — parent restarted`,
      ),
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
    const r = req as {
      url?: string;
      headers?: { origin?: string | string[]; host?: string | string[] };
    };
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
    // CSWSH gate (shared @kolu/surface gate): reject a cross-site browser
    // Origin before the RPC handler (admin or per-host) ever sees the socket.
    // Non-browser clients send no Origin and pass; same-origin UI traffic
    // passes. `gateWsOrigin` reads the headers, `destroy()`s the socket on a
    // reject, and returns true so we return without upgrading.
    if (
      gateWsOrigin({ headers: r.headers ?? {} }, s, {
        allowedOrigins,
        onReject: (o) =>
          log(`rejecting ws upgrade: disallowed Origin ${JSON.stringify(o)}`),
      })
    ) {
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
        // The acceptance seam (@kolu/surface-app, kolu#1545): one call runs the
        // stale-tab gate (a tab that reconnects after a PARENT restart still
        // carries the previous process's `pid` — gated and closed before the
        // oRPC handler upgrades, so its live subscriptions never replay against
        // a process that never had them; an absent `pid`, the first-ever
        // connect, always passes), enrols the accepted socket in the liveness
        // reaper, and only THEN runs the dispatch closure below — sequenced so a
        // socket can't be dispatched without first being gated and enrolled. A
        // stale tab is closed and the closure never runs.
        acceptor.accept(ws, url, () => {
          if (host === ADMIN_HOST_SENTINEL) {
            log("browser ws connect (admin)");
            ws.on("close", (code, reason) =>
              log(
                `browser ws disconnect (admin) (code=${code} reason=${reason.toString() || "<none>"})`,
              ),
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
          void handler.upgrade(
            ws as unknown as Parameters<typeof handler.upgrade>[0],
          );
        });
      },
    );
  });

  const shutdown = (sig: string) => {
    log(`${sig}: destroying host sessions`);
    stopWakeMonitor();
    destroyAllSessions();
    acceptor.stop();
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
