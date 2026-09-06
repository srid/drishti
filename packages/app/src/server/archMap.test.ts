import { describe, expect, it } from "bun:test";
import { agentBinaryCache, resolveSystem } from "@kolu/surface-remote";
import { resolveDrvForHost } from "./archMap";

const TEST_BINARY_CACHE = agentBinaryCache({
  substituters: ["https://cache.example.org"],
  trustedPublicKeys: ["example:AAAA"],
});

/** Localhost's real nix-system, probed once. A dial hands `resolveDrvForHost`
 * this probe pre-bound as `ctx.resolveSystem()`; these tests stand in for the
 * connector, so they run the published `resolveSystem` themselves and bind it. */
const localSystem = resolveSystem("localhost", {
  signal: new AbortController().signal,
  onProgress: () => {},
});

describe("resolveDrvForHost", () => {
  it("returns the .drv from the map when localhost's system is present", async () => {
    const sys = await localSystem;
    const resolved = await resolveDrvForHost(
      "localhost",
      {
        [sys]: "/nix/store/test.drv",
      },
      TEST_BINARY_CACHE,
      { resolveSystem: async () => sys },
    );
    expect(resolved.system).toBe(sys);
    expect(resolved.derivation).toMatchObject({
      kind: "drv-path",
      drvPath: "/nix/store/test.drv",
      binaryCache: TEST_BINARY_CACHE,
    });
  });

  it("throws 'no agent .drv baked' when localhost's system is missing", async () => {
    const sys = await localSystem;
    await expect(
      resolveDrvForHost(
        "localhost",
        { "fake-system": "/nix/store/x" },
        TEST_BINARY_CACHE,
        { resolveSystem: async () => sys },
      ),
    ).rejects.toThrow(/no agent \.drv baked for system=/);
  });
});
