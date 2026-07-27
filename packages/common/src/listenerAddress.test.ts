import { describe, expect, it } from "bun:test";
import { formatListenerAddress } from "./surface";

describe("formatListenerAddress", () => {
  it.each([
    ["IPv4 wildcard", "00000000", 22, "0.0.0.0:22"],
    [
      "IPv6 wildcard",
      "00000000000000000000000000000000",
      22,
      "[::]:22",
    ],
    ["IPv4 loopback", "7f000001", 631, "127.0.0.1:631"],
    [
      "IPv6 loopback",
      "00000000000000000000000000000001",
      631,
      "[::1]:631",
    ],
    [
      "IPv4-mapped IPv6",
      "00000000000000000000ffff7f000001",
      631,
      "127.0.0.1:631",
    ],
    ["Tailscale IPv4", "644e5846", 443, "100.78.88.70:443"],
    [
      "Tailscale IPv6",
      "fd7a115ca1e00000000000003d335846",
      443,
      "[fd7a:115c:a1e0::3d33:5846]:443",
    ],
  ])("decodes the %s scar fixture", (_name, address, port, expected) => {
    expect(formatListenerAddress(address, port)).toBe(expected);
  });
});
