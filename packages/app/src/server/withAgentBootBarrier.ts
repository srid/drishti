/**
 * Connector wrapper: around and after sshConnector spawns the agent, watch for
 * a process death that carries a fatal boot line, and turn it into
 * ConnectError(remote, terminal=true) so the session gives up NOW with the
 * agent's own message — never "host unreachable — retrying forever".
 *
 * Two observation points, because a boot refusal can surface at either: the
 * connector THROWING (the child died before greeting its readiness banner, so
 * no client was ever built), or the returned connection's `closed` (the child
 * greeted and then died). Same stderr, same classification, same verdict.
 */
import {
  ConnectError,
  type ClosedInfo,
  type Connection,
  type Connector,
} from "@kolu/surface-remote";
import {
  AGENT_FATAL_PREFIXES,
  extractAgentBootFatal,
} from "./agentBootRefusal";

export type BootBarrierHooks = {
  /** Called with the verbatim fatal message when a terminal boot refusal is seen. */
  onBootRefused?: (message: string) => void;
  /** Fatal prefixes (default: agent production prefixes). */
  fatalPrefixes?: readonly string[];
};

/**
 * Wrap a connector so an early agent exit with a fatal stderr line becomes a
 * terminal ConnectError (zero reconnects). Transport-class failures without a
 * fatal line pass through unchanged (session still retries network).
 */
export function withAgentBootBarrier<Client>(
  inner: Connector<Client>,
  hooks: BootBarrierHooks = {},
): Connector<Client> {
  const prefixes = hooks.fatalPrefixes ?? AGENT_FATAL_PREFIXES;
  return async (ctx) => {
    const remoteLines: string[] = [];
    const innerCtx = {
      ...ctx,
      remoteProgress: (line: string) => {
        remoteLines.push(line);
        ctx.remoteProgress(line);
      },
    };

    // An early agent exit now has TWO shapes, and the barrier owes the same
    // verdict to both (juspay/kolu#2101).
    //
    // It used to have one: `sshConnector` handed back a Connection immediately
    // — it spliced the child's stdio into an RPC client without asking the peer
    // anything — so a boot refusal could only ever be observed downstream, as
    // `conn.closed`. The readiness gate moved that observation EARLIER: the
    // connector now waits for the peer's banner before it will build a client,
    // races that wait against the child's own exit, and a child that dies
    // without greeting makes the connector THROW instead of return.
    //
    // Catching that throw is not a fallback — it is the same classification at
    // the same instant, reached by the new control path. Without it, a planted
    // 0755 state dir (the one refusal this barrier exists for) regresses from
    // "terminal, with the agent's own sentence" to "host unreachable", which is
    // the retry-forever class the gate was built to abolish.
    let conn: Connection<Client>;
    try {
      conn = await inner(innerCtx);
    } catch (err) {
      await drainLateStderr(remoteLines, prefixes);
      const fatal = extractAgentBootFatal(remoteLines, prefixes);
      if (fatal !== null) {
        hooks.onBootRefused?.(fatal);
        throw new ConnectError(fatal, "remote", true);
      }
      // No fatal line: this is the connector's own verdict (a refused or silent
      // peer, a transport failure) and it is already classified. Rethrowing it
      // unchanged is what keeps the gate's terminal budget the one authority —
      // re-wrapping here would relabel a fact the connector established.
      throw err;
    }

    const closedP = conn.closed.then((info) => info);

    // Race process death vs first liveness probe. A fatal boot (daemonHome
    // refuse) dies before serving — closed wins with remote stderr carrying
    // `drishti-agent: fatal: …`. A healthy agent answers isAlive and we adopt.
    const race = await Promise.race([
      closedP.then((info) => ({ kind: "closed" as const, info })),
      conn.isAlive().then(
        () => ({ kind: "up" as const }),
        () => ({ kind: "probe-fail" as const }),
      ),
    ]);

    if (race.kind === "closed") {
      await drainLateStderr(remoteLines, prefixes);
      return refuseOrRewrap(conn, race.info, remoteLines, prefixes, hooks);
    }

    if (race.kind === "probe-fail") {
      // Probe failed — process may already be dead (stream closed). Check closed.
      const info = await Promise.race([
        closedP,
        new Promise<null>((r) => setTimeout(() => r(null), 100)),
      ]);
      if (info !== null) {
        await drainLateStderr(remoteLines, prefixes);
        return refuseOrRewrap(conn, info, remoteLines, prefixes, hooks);
      }
      // Still running; admit will diagnose. Hand the connection to the session.
    }

    return {
      ...conn,
      closed: closedP,
    };
  };
}

/**
 * After process exit, stderr data events can land one tick late (GHA race).
 * Poll briefly until a fatal prefix appears or the budget is spent.
 */
async function drainLateStderr(
  remoteLines: readonly string[],
  prefixes: readonly string[],
): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (extractAgentBootFatal(remoteLines, prefixes) !== null) return;
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setTimeout(r, 15));
  }
}

function refuseOrRewrap<Client>(
  conn: Connection<Client>,
  info: ClosedInfo,
  remoteLines: readonly string[],
  prefixes: readonly string[],
  hooks: BootBarrierHooks,
): Connection<Client> {
  const fatal = extractAgentBootFatal(remoteLines, prefixes);
  if (fatal !== null) {
    hooks.onBootRefused?.(fatal);
    try {
      conn.teardown();
    } catch {
      //
    }
    // terminal=true ⇒ scheduleReconnect gives up immediately (zero retries).
    throw new ConnectError(fatal, "remote", true);
  }
  // Early exit without fatal prefix — session's normal handleClosed path
  // (bounded remote, not endless network) when it observes the closed arm.
  return {
    ...conn,
    closed: Promise.resolve(info),
  };
}
