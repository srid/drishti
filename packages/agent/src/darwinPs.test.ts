import { describe, expect, it } from "bun:test";
import {
  DARWIN_PS_ARGS,
  DARWIN_PS_PATH,
  parseDarwinProcessUsage,
  readDarwinProcessUsage,
} from "./darwinPs";

describe("Darwin ps process usage", () => {
  it("parses CPU percent and converts resident KiB to bytes", () => {
    expect(
      [...
        parseDarwinProcessUsage(
          "  42  12.5  1024\n   7   0.0     0\nnoise\n  9 nope 20\n",
        ),
      ],
    ).toEqual([
      [42, { cpuPct: 12.5, rssBytes: 1_048_576 }],
      [7, { cpuPct: 0, rssBytes: 0 }],
    ]);
  });

  it("owns the absolute Apple ps invocation separately from parsing", async () => {
    const calls: unknown[] = [];
    const usage = await readDarwinProcessUsage(async (path, args, options) => {
      calls.push({ path, args, options });
      return "42 3.5 2048\n";
    });

    expect(calls).toEqual([
      {
        path: DARWIN_PS_PATH,
        args: DARWIN_PS_ARGS,
        options: {
          timeout: 1_500,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024 * 1024,
        },
      },
    ]);
    expect(usage.get(42)).toEqual({ cpuPct: 3.5, rssBytes: 2_097_152 });
  });
});
