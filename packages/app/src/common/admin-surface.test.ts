import { describe, expect, it } from "bun:test";
import { ADMIN_HOST_SENTINEL, isValidHost } from "./admin-surface";

describe("isValidHost", () => {
  it("accepts ordinary ssh targets", () => {
    for (const host of [
      "localhost",
      "user@host-b",
      "a.lan",
      "db-internal", // an ~/.ssh/config alias with an interior dash
      "192.168.1.5",
      "[::1]",
      "user@192.168.1.5",
      "host-with-trailing-dash-ok",
    ]) {
      expect(isValidHost(host)).toBe(true);
    }
  });

  it("rejects a leading-dash host — the ssh option-injection vector", () => {
    // The headline bug: a host string that ssh would parse as an OPTION
    // rather than a destination. `-oProxyCommand=...` makes ssh run an
    // arbitrary command via /bin/sh. The `$IFS` form sidesteps a naive
    // whitespace filter, and a single-token command needs no whitespace at
    // all — so the load-bearing check is the leading `-`, not whitespace.
    for (const host of [
      "-oProxyCommand=reboot",
      "-oProxyCommand=touch$IFS/tmp/pwned",
      "-oProxyCommand=touch${IFS}/tmp/pwned",
      "-oPermitLocalCommand=yes",
      "-Fnone",
      "-G",
      "--",
      "-",
    ]) {
      expect(isValidHost(host)).toBe(false);
    }
  });

  it("rejects empty, whitespace-bearing, and sentinel hosts", () => {
    expect(isValidHost("")).toBe(false);
    expect(isValidHost("host with space")).toBe(false);
    expect(isValidHost("host\twith\ttab")).toBe(false);
    expect(isValidHost("host\nnewline")).toBe(false);
    expect(isValidHost(ADMIN_HOST_SENTINEL)).toBe(false);
  });
});
