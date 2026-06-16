/**
 * On-disk hosts persistence.
 *
 * Format: JSON `{ "hosts": ["host-a", "user@host-b", ...] }`. The parent
 * server reads this at boot (when no CLI args override) and writes it on
 * every admin-surface mutation (add/remove). De-duplicates and preserves
 * first-occurrence order so a UI re-add doesn't reshuffle tab positions.
 *
 * Resolution order for the file path:
 *
 *   1. `DRISHTI_HOSTS_FILE` env var (explicit override).
 *   2. `$XDG_STATE_HOME/drishti/hosts.json`
 *   3. `$HOME/.local/state/drishti/hosts.json`
 *
 * Missing file → empty list (not an error: first-run case).
 * Malformed JSON → empty list + stderr warning (don't crash the parent
 * over a corrupt state file the user can easily delete).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isValidHost } from "../common/host";
import { makeLogger } from "./log";

const log = makeLogger("hosts");

export function resolveHostsFile(): string {
  const override = process.env.DRISHTI_HOSTS_FILE;
  if (override !== undefined && override.length > 0) return override;
  const xdg = process.env.XDG_STATE_HOME;
  const base =
    xdg !== undefined && xdg.length > 0
      ? xdg
      : join(homedir(), ".local", "state");
  return join(base, "drishti", "hosts.json");
}

export async function loadHosts(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    log(`read failed: ${(err as Error).message}`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log(`malformed JSON in ${file}: ${(err as Error).message}`);
    return [];
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("hosts" in parsed) ||
    !Array.isArray((parsed as { hosts: unknown }).hosts)
  ) {
    return [];
  }
  const strings = (parsed as { hosts: unknown[] }).hosts.filter(
    (h): h is string => typeof h === "string" && h.length > 0,
  );
  // Re-validate on load — the same boundary check the admin surface applies
  // to new hosts. A persisted file is attacker-reachable state (a prior
  // exploit, or hand-tampering), and these entries are re-seeded into the
  // registry at boot and handed to `ssh`; a value like `-oProxyCommand=...`
  // must not survive a restart just because it once reached disk.
  const valid = strings.filter(isValidHost);
  for (const h of strings) {
    if (!isValidHost(h)) log(`dropping invalid persisted host: ${h}`);
  }
  return dedupe(valid);
}

export async function saveHosts(
  file: string,
  hosts: readonly string[],
): Promise<void> {
  const cleaned = dedupe(hosts.filter((h) => h.length > 0));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ hosts: cleaned }, null, 2)}\n`,
    "utf-8",
  );
}

function dedupe(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
