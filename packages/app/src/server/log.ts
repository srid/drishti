/**
 * Parent-server logging primitives.
 *
 * One concept — "write a tagged diagnostic line to stderr" — that the
 * server used to hand-roll five separate ways (`[server]`, `[hosts]`,
 * `[bridge]`, `[admin]`, …). `makeLogger(tag)` is the single factory;
 * every caller closes over its own tag. The bridge builds a *per-host*
 * tag (`bridge:${host}`) so the five concurrent per-host bridge loops
 * stop interleaving into one indistinguishable `[bridge]` stream.
 *
 * Timestamps are deliberately NOT added here. They are a property of
 * *when a line reaches the sink*, not of each writer — and prefixing
 * per-writer would miss the lines drishti does not own: `@kolu/surface-
 * nix-host` writes its `[host:X local|remote]` progress straight to
 * `process.stderr`, and the remote agent's stderr arrives the same way
 * (kolu forwards it). `installStderrTimestamps` stamps the unified
 * stream once, at the single fd every writer shares, so kolu's lines and
 * the forwarded agent lines get the same treatment as drishti's own.
 */

export type Logger = (line: string) => void;

/** Build a logger that prefixes every line with `[tag] ` and writes it
 *  to stderr. The tag carries the subsystem identity (`server`,
 *  `hosts`, `admin`) or, for the bridge, the per-host discriminator
 *  (`bridge:user@host`) that lets multi-host logs be told apart. */
export function makeLogger(tag: string): Logger {
  return (line: string): void => {
    process.stderr.write(`[${tag}] ${line}\n`);
  };
}

/** Wrap `process.stderr.write` once so every line — drishti's own,
 *  kolu's direct writes, and the remote agent's forwarded stderr —
 *  carries an ISO-8601 millisecond timestamp. Installed once at parent
 *  boot.
 *
 *  Every writer in this process emits one complete `\n`-terminated line
 *  per call, so stamping at each line start within the chunk is exact;
 *  the `(?=.)` guard skips the empty segment after a trailing newline so
 *  a lone `\n` isn't given a stray timestamp.
 *
 *  Idempotent by construction: the marker below is stamped onto the
 *  installed wrapper, so a second call (or a re-imported module) returns
 *  early instead of wrapping the already-wrapped `write` — which would
 *  nest a second stamping pass and double-prefix every line. */
const STDERR_TIMESTAMPED = Symbol("drishti.stderr.timestamped");
type MarkedWrite = typeof process.stderr.write & {
  [STDERR_TIMESTAMPED]?: true;
};

export function installStderrTimestamps(): void {
  if ((process.stderr.write as MarkedWrite)[STDERR_TIMESTAMPED]) return;
  const original = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: matching Node's overloaded write() signature, which we forward verbatim.
  const wrapper = ((chunk: any, ...rest: any[]): boolean => {
    if (typeof chunk === "string") {
      const stamped = chunk.replace(/^(?=.)/gm, `${new Date().toISOString()} `);
      // biome-ignore lint/suspicious/noExplicitAny: forwarding the original variadic (encoding?, cb?) tail unchanged.
      return original(stamped, ...(rest as [any]));
    }
    // biome-ignore lint/suspicious/noExplicitAny: non-string (Buffer) chunks pass through unstamped — no writer uses them.
    return original(chunk, ...(rest as [any]));
  }) as MarkedWrite;
  wrapper[STDERR_TIMESTAMPED] = true;
  process.stderr.write = wrapper;
}
