import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHosts, resolveHostsFile, saveHosts } from "./hostsStore";

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "drishti-hosts-"));
}

describe("hostsStore", () => {
  it("returns [] when the file is missing", async () => {
    const dir = scratchDir();
    try {
      expect(await loadHosts(join(dir, "missing.json"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a host list and creates parent dirs", async () => {
    const dir = scratchDir();
    const file = join(dir, "nested", "deeper", "hosts.json");
    try {
      await saveHosts(file, ["host-a", "user@host-b", "127.0.0.1"]);
      expect(await loadHosts(file)).toEqual([
        "host-a",
        "user@host-b",
        "127.0.0.1",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedupes preserving first occurrence", async () => {
    const dir = scratchDir();
    const file = join(dir, "hosts.json");
    try {
      await saveHosts(file, ["a", "b", "a", "c", "b"]);
      expect(await loadHosts(file)).toEqual(["a", "b", "c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers from malformed JSON by returning []", async () => {
    const dir = scratchDir();
    const file = join(dir, "hosts.json");
    try {
      await writeFile(file, "{ not json", "utf-8");
      expect(await loadHosts(file)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-string entries in the array", async () => {
    const dir = scratchDir();
    const file = join(dir, "hosts.json");
    try {
      await writeFile(
        file,
        JSON.stringify({ hosts: ["a", 42, null, "b", ""] }),
        "utf-8",
      );
      expect(await loadHosts(file)).toEqual(["a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops persisted hosts that fail validation (ssh option injection)", async () => {
    // A tampered or exploit-written state file must not re-seed a host that
    // ssh would parse as an option. The leading-dash entries are dropped;
    // the legitimate interior-dash alias survives.
    const dir = scratchDir();
    const file = join(dir, "hosts.json");
    try {
      await writeFile(
        file,
        JSON.stringify({
          hosts: [
            "good-host",
            "-oProxyCommand=touch$IFS/tmp/pwned",
            "user@host-b",
            "-Fnone",
          ],
        }),
        "utf-8",
      );
      expect(await loadHosts(file)).toEqual(["good-host", "user@host-b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveHostsFile honors DRISHTI_HOSTS_FILE override", () => {
    const prev = process.env.DRISHTI_HOSTS_FILE;
    process.env.DRISHTI_HOSTS_FILE = "/tmp/explicit/hosts.json";
    try {
      expect(resolveHostsFile()).toBe("/tmp/explicit/hosts.json");
    } finally {
      if (prev === undefined) delete process.env.DRISHTI_HOSTS_FILE;
      else process.env.DRISHTI_HOSTS_FILE = prev;
    }
  });

  it("resolveHostsFile falls back through XDG_STATE_HOME", () => {
    const prev = process.env.XDG_STATE_HOME;
    const prevOverride = process.env.DRISHTI_HOSTS_FILE;
    delete process.env.DRISHTI_HOSTS_FILE;
    process.env.XDG_STATE_HOME = "/tmp/xdg-state";
    try {
      expect(resolveHostsFile()).toBe("/tmp/xdg-state/drishti/hosts.json");
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
      if (prevOverride !== undefined)
        process.env.DRISHTI_HOSTS_FILE = prevOverride;
    }
  });
});
