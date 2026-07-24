import { describe, expect, it } from "bun:test";
import { resolveSystem } from "@kolu/surface-remote";
import { resolveDrvForHost } from "./archMap";

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
      { signal, localProgress: () => {} },
    );
    expect(drv).toMatchObject({
      kind: "drv-path",
      drvPath: "/nix/store/test.drv",
    });
  });

  it("throws 'no agent .drv baked' when localhost's system is missing", async () => {
    await expect(
      resolveDrvForHost(
        "localhost",
        { "fake-system": "/nix/store/x" },
        {
          signal: new AbortController().signal,
          localProgress: () => {},
        },
      ),
    ).rejects.toThrow(/no agent \.drv baked for system=/);
  });
});
