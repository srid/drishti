import { describe, expect, it } from "bun:test";
import {
  UNAME_TO_NIX_SYSTEM,
  resolveSystem,
  unameToNixSystem,
} from "./archMap";

describe("unameToNixSystem", () => {
  it("maps the four supported uname -ms outputs", () => {
    expect(unameToNixSystem("Linux x86_64")).toBe("x86_64-linux");
    expect(unameToNixSystem("Linux aarch64")).toBe("aarch64-linux");
    expect(unameToNixSystem("Darwin arm64")).toBe("aarch64-darwin");
    expect(unameToNixSystem("Darwin x86_64")).toBe("x86_64-darwin");
  });

  it("trims trailing newline (uname output is line-terminated)", () => {
    expect(unameToNixSystem("Linux x86_64\n")).toBe("x86_64-linux");
  });

  it("returns null for unsupported output", () => {
    expect(unameToNixSystem("FreeBSD amd64")).toBeNull();
    expect(unameToNixSystem("")).toBeNull();
  });

  it("table values are valid nix-system strings (arch-os)", () => {
    for (const sys of Object.values(UNAME_TO_NIX_SYSTEM)) {
      expect(sys).toMatch(/^(x86_64|aarch64)-(linux|darwin)$/);
    }
  });
});

describe("resolveSystem", () => {
  it("resolves localhost to a known nix-system", async () => {
    const sys = await resolveSystem("localhost");
    expect(Object.values(UNAME_TO_NIX_SYSTEM)).toContain(sys);
  });
});
