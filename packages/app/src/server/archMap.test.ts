import { describe, expect, it } from "bun:test";
import { type AgentBinaryCache, resolveSystem } from "@kolu/surface-remote";
import { resolveDrvForHost } from "./archMap";

const TEST_BINARY_CACHE: AgentBinaryCache = {
  substituters: ["https://cache.example.org"],
  trustedPublicKeys: ["example:AAAA"],
};

describe("resolveDrvForHost", () => {
  it("returns the .drv from the map when localhost's system is present", async () => {
    const signal = new AbortController().signal;
    const sys = await resolveSystem("localhost", {
      signal,
      onProgress: () => {},
    });
    const drv = await resolveDrvForHost(
      "localhost",
      {
        [sys]: "/nix/store/test.drv",
      },
      TEST_BINARY_CACHE,
      { signal, localProgress: () => {} },
    );
    expect(drv).toMatchObject({
      kind: "drv-path",
      drvPath: "/nix/store/test.drv",
      binaryCache: TEST_BINARY_CACHE,
    });
  });

  it("throws 'no agent .drv baked' when localhost's system is missing", async () => {
    await expect(
      resolveDrvForHost(
        "localhost",
        { "fake-system": "/nix/store/x" },
        TEST_BINARY_CACHE,
        {
          signal: new AbortController().signal,
          localProgress: () => {},
        },
      ),
    ).rejects.toThrow(/no agent \.drv baked for system=/);
  });
});
