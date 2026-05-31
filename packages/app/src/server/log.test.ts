import { describe, expect, it } from "bun:test";
import { installStderrTimestamps, makeLogger } from "./log";

/** Run `fn` with `process.stderr.write` swapped for a capturing stub,
 *  always restoring the original — `installStderrTimestamps` mutates the
 *  global, so a leak would corrupt every later test's stderr. Captures
 *  raw chunks (string or Buffer) so the Buffer pass-through is checkable. */
function captureStderr(fn: () => void): unknown[] {
  const original = process.stderr.write;
  const out: unknown[] = [];
  process.stderr.write = ((chunk: unknown): boolean => {
    out.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

describe("makeLogger", () => {
  it("prefixes the tag in brackets and terminates with a newline", () => {
    const out = captureStderr(() => {
      makeLogger("server")("hello");
      makeLogger("bridge:user@host")("client #2 ready");
    });
    expect(out).toEqual([
      "[server] hello\n",
      "[bridge:user@host] client #2 ready\n",
    ]);
  });
});

describe("installStderrTimestamps", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

  it("stamps a single complete line", () => {
    const out = captureStderr(() => {
      installStderrTimestamps();
      process.stderr.write("[server] one\n");
    });
    const line = out[0] as string;
    expect(line).toMatch(ISO);
    expect(line).toMatch(/ \[server\] one\n$/);
  });

  it("stamps every line in a multi-line chunk but not the trailing newline", () => {
    const out = captureStderr(() => {
      installStderrTimestamps();
      process.stderr.write("a\nb\n");
    });
    const lines = (out[0] as string).split("\n");
    expect(lines[0]).toMatch(ISO);
    expect(lines[0]).toContain("a");
    expect(lines[1]).toMatch(ISO);
    expect(lines[1]).toContain("b");
    // The empty segment after the final "\n" must NOT get a stray stamp —
    // otherwise a bare line ending would sprout a timestamp with no text.
    expect(lines[2]).toBe("");
  });

  it("passes non-string (Buffer) chunks through untouched", () => {
    const buf = Buffer.from("raw\n");
    const out = captureStderr(() => {
      installStderrTimestamps();
      process.stderr.write(buf);
    });
    expect(out[0]).toBe(buf);
  });
});
