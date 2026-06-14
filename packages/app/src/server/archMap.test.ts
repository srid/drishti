import { describe, expect, it } from "vitest";
import { resolveSystem } from "@kolu/surface-nix-host";
import { resolveDrvForHost } from "./archMap";

describe("resolveDrvForHost", () => {
  it("returns the .drv from the map when localhost's system is present", async () => {
    const sys = await resolveSystem("localhost");
    const drv = await resolveDrvForHost("localhost", {
      [sys]: "/nix/store/test-drv",
    });
    expect(drv).toBe("/nix/store/test-drv");
  });

  it("throws 'no agent .drv baked' when localhost's system is missing", async () => {
    await expect(
      resolveDrvForHost("localhost", { "fake-system": "/nix/store/x" }),
    ).rejects.toThrow(/no agent \.drv baked for system=/);
  });
});
