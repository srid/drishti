/**
 * Connector wrapper: after sshConnector spawns the agent, wait for either a
 * live transport OR a process death. If death carries a fatal boot line,
 * throw ConnectError(remote, terminal=true) so the session gives up NOW with
 * the agent's message — never "host unreachable — retrying forever".
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
    const conn = await inner({
      ...ctx,
      remoteProgress: (line: string) => {
        remoteLines.push(line);
        ctx.remoteProgress(line);
      },
    });

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
