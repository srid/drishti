/**
 * Client-side surface bundle — WebSocket-over-oRPC transport. The
 * parent server (this app) serves the same surface that the remote
 * agent serves over stdio; the parent forwards everything through.
 */

import type { ClientRetryPluginContext } from "@orpc/client/plugins";
import type { ContractRouterClient } from "@orpc/contract";
import { surfaceClient } from "@kolu/surface/solid";
import { WebSocket as PartySocket } from "partysocket";
import { surface } from "../common/surface";

const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/rpc/ws`;
// `partysocket`'s `WebSocket` export is `ReconnectingWebSocket`; its
// `(url, protocols, options)` ctor sets these defaults: connectionTimeout
// 4s, minUptime 5s, minReconnectionDelay 1–5s. During cold start the
// parent is busy provisioning the agent on the remote (`nix copy
// --derivation` + remote realise — easily 30+ seconds on first run), so
// the 4s deadline trips every connect, partysocket reopens a fresh ws,
// the parent logs a new `browser ws connect`, repeat 6+ times. Bump the
// deadlines to fit the expected provisioning window.
export const ws = new PartySocket(wsUrl, undefined, {
  connectionTimeout: 60_000,
  minReconnectionDelay: 2_000,
  maxReconnectionDelay: 15_000,
});

export const app = surfaceClient<
  typeof surface.spec,
  ContractRouterClient<typeof surface.contract, ClientRetryPluginContext>
>(surface, { websocket: ws as unknown as WebSocket });
