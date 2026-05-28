/**
 * Resolve a host string to its nix-system identifier.
 *
 * Same probe (`uname -ms`) runs locally for `localhost` and over `ssh`
 * for remotes — one mapping table covers both. The returned system
 * string keys into the `agentDrvBySystem` map baked at build time by
 * the monitor wrapper (`default.nix`); the caller picks the matching
 * `.drv` and hands it to `getHostSession`.
 *
 * Why the probe lives in drishti, not in `@kolu/surface-nix-host`:
 * kolu's `provisionAgent` (`nixCopy.ts:1-30`) is intentionally
 * arch-agnostic — it takes one `.drv` per session and ships exactly
 * that. The library's docstring says the *caller* must pick a
 * derivation for the remote's arch. A future second kolu consumer
 * would do the same probe; the table belongs upstream once that
 * happens (see the README's upstreaming note).
 */

import { spawn } from "node:child_process";
import { isLocalHost } from "@kolu/surface-nix-host";

// Entries must stay a subset of `flake.nix`'s `systems` list — the
// monitor only bakes drvs for the systems that list names, and a uname
// string mapped here without a matching baked drv would resolve fine
// then fail downstream with a misleading "no .drv baked" error. An
// unmapped uname instead throws "unsupported `uname -ms` output" at
// the probe layer, which is the clearer failure.
//
// `x86_64-darwin` (Intel Mac) is intentionally absent: not in the
// flake's `systems` list. Add it here only after adding it there.
export const UNAME_TO_NIX_SYSTEM: Readonly<Record<string, string>> = {
  "Linux x86_64": "x86_64-linux",
  "Linux aarch64": "aarch64-linux",
  "Darwin arm64": "aarch64-darwin",
};

/** Pure mapping from `uname -ms` output → nix-system, or `null` for
 *  unsupported. Split from `resolveSystem` so the table can be tested
 *  without spawning `uname`/`ssh`. */
export function unameToNixSystem(unameOut: string): string | null {
  return UNAME_TO_NIX_SYSTEM[unameOut.trim()] ?? null;
}

export async function resolveSystem(host: string): Promise<string> {
  const [cmd, ...args] = isLocalHost(host)
    ? ["uname", "-ms"]
    : ["ssh", "-o", "BatchMode=yes", host, "uname", "-ms"];
  const out = await capture(cmd as string, args);
  const sys = unameToNixSystem(out);
  if (sys === null) {
    throw new Error(
      `${host}: unsupported \`uname -ms\` output ${JSON.stringify(out.trim())} (known: ${Object.keys(UNAME_TO_NIX_SYSTEM).map((k) => JSON.stringify(k)).join(", ")})`,
    );
  }
  return sys;
}

/** Compose the probe with the build-time `system → drvPath` map. The
 *  map is supplied by the caller (parsed from `DRISHTI_AGENT_DRVS_JSON`
 *  in `main.ts`) — `archMap.ts` doesn't own the map, just the
 *  composition. The two failure modes are intentionally distinct:
 *  `resolveSystem` throws "unsupported \`uname -ms\` output" when the
 *  OS isn't in `UNAME_TO_NIX_SYSTEM`; the throw below fires when the OS
 *  *is* known but no .drv was baked for it (e.g. Intel Mac targeting a
 *  monitor that only baked `aarch64-darwin`). */
export async function resolveDrvForHost(
  host: string,
  drvBySystem: Readonly<Record<string, string>>,
): Promise<string> {
  const sys = await resolveSystem(host);
  const drv = drvBySystem[sys];
  if (drv === undefined) {
    throw new Error(
      `${host}: no agent .drv baked for system=${sys} (known: ${Object.keys(drvBySystem).join(", ")})`,
    );
  }
  return drv;
}

// Local copy of `@kolu/surface-nix-host`'s private `runCapture`
// (nixCopy.ts). Upstream is not exported, so this stays a duplicate
// until kolu surfaces a shared subprocess-capture helper. Differs only
// in stderr handling — kolu forwards lines to `onProgress`; we
// accumulate into the error message because there's no progress channel
// at probe time.
function capture(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    proc.on("close", (code, signal) => {
      if (code === 0) resolve(stdout);
      else {
        const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
        const exit =
          code !== null
            ? `exited ${code}`
            : `killed by signal ${signal ?? "unknown"}`;
        reject(new Error(`${cmd} ${exit}${detail}`));
      }
    });
    proc.on("error", (err) => reject(err));
  });
}
