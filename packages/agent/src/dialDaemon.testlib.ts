/**
 * Test-only dial helpers for the agent daemon's THREE-sibling wire.
 *
 * Not a package export (`packages/agent/package.json` `exports` stays `["." ,
 * "./package.json"]` — pinned by `exportsMap.test.ts`); tests import it
 * relatively.
 *
 * One link, three faces. Effect RPC builds ONE client from the combined flat
 * `RpcGroup`, and each sibling's face is re-nested from that sibling's own
 * `Surface` value over the SAME dispatch — the shape `Connection.dispatch`
 * exists for, and the same one the parent uses in production.
 */

import type { Readable, Writable } from "node:stream";
import { buildSurfaceFace } from "@kolu/surface/client";
import { stdioLink } from "@kolu/surface/links/stdio";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import { Effect, Fiber, Option, Stream } from "effect";
import {
  agentControlSurface,
  agentDaemonComposed,
  agentDialSurface,
  agentDrainSurface,
  type DrainVerdict,
} from "drishti-common/daemon";
import type { MetricHistoryMsg, SystemInfo } from "drishti-common";
import type { Alerts } from "drishti-common/alerts";

/** The frozen control-core face, as the supervisor's probe walks it. */
export interface ControlFace {
  hello: () => Promise<{
    stateRoot: string;
    surfaceVersion: string;
    controlCoreVersion: string;
    startedAt: number;
    commit?: string;
    buildId?: string;
  }>;
  drain: () => Promise<void>;
}

/** Every face over one dialled daemon, plus the link's disposer. */
export interface DaemonDial {
  /** The agent's app surface — `metricHistory`, `system`, `process.kill`, … */
  readonly app: {
    metricHistory: {
      get: (input: Record<string, never>) => Stream.Stream<MetricHistoryMsg>;
    };
    system: { get: (input?: undefined) => Stream.Stream<SystemInfo> };
    alerts: { get: (input?: undefined) => Stream.Stream<Alerts> };
    process: {
      kill: (input: {
        pid: number;
        signal?: "TERM" | "KILL" | "HUP" | "INT";
      }) => Promise<{ ok: boolean; error?: string }>;
    };
  };
  /** The framework's frozen fragment. */
  readonly control: ControlFace;
  /** drishti's own drain — the one that ANSWERS with the persist verdict. */
  readonly drain: () => Promise<DrainVerdict>;
  dispose: () => Promise<void>;
}

/**
 * THE run edge for this testlib's unary verbs.
 *
 * A unary member call is an `Effect` — a description that dispatches nothing
 * until it is run. So the faces below cannot simply be CAST to a Promise
 * shape: `await` on an un-run Effect compiles, resolves with the Effect object,
 * and never touches the wire — a test that fails to dispatch the call it
 * asserts about is worse than no test. Running it here, once, is what keeps
 * every call site's `await client.control.hello()` honest.
 */
function unary<A>(call: () => Effect.Effect<A, unknown>): () => Promise<A> {
  return () => Effect.runPromise(call());
}

function facesOver(
  dispatch: Parameters<typeof buildSurfaceFace>[1],
  dispose: () => Promise<void>,
): DaemonDial {
  const appFace = buildSurfaceFace(agentDialSurface, dispatch)
    .surface as unknown as Omit<DaemonDial["app"], "process"> & {
    process: {
      kill: (input: {
        pid: number;
        signal?: "TERM" | "KILL" | "HUP" | "INT";
      }) => Effect.Effect<{ ok: boolean; error?: string }, unknown>;
    };
  };
  const app: DaemonDial["app"] = {
    metricHistory: appFace.metricHistory,
    system: appFace.system,
    alerts: appFace.alerts,
    process: {
      kill: (input) => Effect.runPromise(appFace.process.kill(input)),
    },
  };
  const core = (
    buildSurfaceFace(agentControlSurface, dispatch).surface as unknown as {
      core: {
        hello: () => Effect.Effect<
          Awaited<ReturnType<ControlFace["hello"]>>,
          unknown
        >;
        drain: () => Effect.Effect<void, unknown>;
      };
    }
  ).core;
  const control: ControlFace = {
    hello: unary(() => core.hello()),
    drain: unary(() => core.drain()),
  };
  const drainFace = buildSurfaceFace(agentDrainSurface, dispatch)
    .surface as unknown as {
    ring: { drain: () => Effect.Effect<DrainVerdict, unknown> };
  };
  return {
    app,
    control,
    drain: unary(() => drainFace.ring.drain()),
    dispose,
  };
}

/** Dial the daemon through a `--stdio` front child's pipes. */
export async function dialOverStdio(
  read: Readable,
  write: Writable,
): Promise<DaemonDial> {
  const link = await stdioLink({
    group: agentDaemonComposed.group,
    read,
    write,
  });
  return facesOver(link.dispatch, () => link.dispose());
}

/** Dial the daemon's unix socket directly — the leg that survives the front
 *  dying, which is why the drain tests use it. */
export async function dialOverUnixSocket(
  socketPath: string,
): Promise<DaemonDial> {
  const link = await unixSocketLink({
    group: agentDaemonComposed.group,
    socketPath,
  });
  return facesOver(link.dispatch, () => link.dispose());
}

// ── Stream consumption helpers ────────────────────────────────────────────
//
// There is no `AbortSignal` on a surface stream any more: teardown IS fiber
// interruption. These three helpers are the only shapes the agent's tests
// need, so no test re-derives the run edge.

/** The stream's FIRST frame, then interrupt. Throws if it ends empty — a
 *  member that ends without a frame is a defect, never "no data". */
export async function firstFrame<A>(stream: Stream.Stream<A>): Promise<A> {
  const head = await Effect.runPromise(
    Stream.runHead(stream) as Effect.Effect<Option.Option<A>, never, never>,
  );
  if (Option.isNone(head)) {
    throw new Error("stream ended without a frame");
  }
  return head.value;
}

/** Collect frames until `done` says stop, then interrupt. Rejects on timeout
 *  rather than resolving short — a partial collection would make an assertion
 *  about what the daemon served into an assertion about how fast the test ran. */
export async function framesUntil<A>(
  stream: Stream.Stream<A>,
  done: (frames: readonly A[]) => boolean,
  timeoutMs = 15_000,
): Promise<A[]> {
  const frames: A[] = [];
  const collector = collect(stream, frames);
  const deadline = Date.now() + timeoutMs;
  try {
    while (!done(frames)) {
      if (Date.now() > deadline) {
        throw new Error(
          `stream did not satisfy the predicate within ${timeoutMs}ms (${frames.length} frame(s) seen)`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return [...frames];
  } finally {
    await collector.stop();
  }
}

/** A live collector whose fiber runs until `stop()` interrupts it. */
export function collect<A>(
  stream: Stream.Stream<A>,
  into: A[] = [],
): { readonly frames: A[]; stop: () => Promise<void> } {
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (frame: A) =>
      Effect.sync(() => {
        into.push(frame);
      }),
    ) as Effect.Effect<void, never, never>,
  );
  return {
    frames: into,
    stop: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}
