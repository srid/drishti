import { describe, expect, it } from "bun:test";
import { isAllowedWsOrigin, parseAllowedOrigins } from "./wsOrigin";

const allow = (
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[] = [],
) => isAllowedWsOrigin({ origin, host, allowedOrigins });

describe("isAllowedWsOrigin", () => {
  it("allows a same-origin upgrade (the drishti UI talking to itself)", () => {
    expect(allow("http://localhost:7720", "localhost:7720")).toBe(true);
    expect(allow("http://127.0.0.1:7720", "127.0.0.1:7720")).toBe(true);
    expect(allow("https://box.tailnet.ts.net", "box.tailnet.ts.net")).toBe(
      true,
    );
  });

  it("allows a missing Origin (non-browser client: CLI, curl, tests)", () => {
    expect(allow(undefined, "localhost:7720")).toBe(true);
    expect(allow("", "localhost:7720")).toBe(true);
  });

  it("rejects a cross-site Origin — the CSWSH vector", () => {
    expect(allow("https://evil.example", "localhost:7720")).toBe(false);
    // Same host, different port is still a different origin.
    expect(allow("http://localhost:9999", "localhost:7720")).toBe(false);
    // A host that merely embeds the target as a substring must not pass.
    expect(allow("http://localhost:7720.evil.example", "localhost:7720")).toBe(
      false,
    );
  });

  it("rejects a malformed or opaque ('null') Origin", () => {
    expect(allow("null", "localhost:7720")).toBe(false);
    expect(allow("not a url", "localhost:7720")).toBe(false);
  });

  it("honors the explicit allowlist for reverse-proxy / tailscale setups", () => {
    // Browser at the tailnet FQDN, but the proxy forwards Host=127.0.0.1:7720.
    expect(
      allow("https://box.tailnet.ts.net", "127.0.0.1:7720", [
        "https://box.tailnet.ts.net",
      ]),
    ).toBe(true);
    // Allowlist is exact-match: a near-miss is still rejected.
    expect(
      allow("https://evil.example", "127.0.0.1:7720", [
        "https://box.tailnet.ts.net",
      ]),
    ).toBe(false);
  });

  it("rejects when the Host header is absent and Origin is present", () => {
    expect(allow("http://localhost:7720", undefined)).toBe(false);
  });
});

describe("parseAllowedOrigins", () => {
  it("returns [] for undefined or blank", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins("  , ,")).toEqual([]);
  });

  it("splits, trims, and drops empties", () => {
    expect(
      parseAllowedOrigins("https://a.example, https://b.example ,"),
    ).toEqual(["https://a.example", "https://b.example"]);
  });
});
