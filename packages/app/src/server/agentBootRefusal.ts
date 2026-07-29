/**
 * Detect a TERMINAL agent-boot refusal from remote stderr lines that crossed
 * the stdio front before exit (kaval dialAgentOnce fatalPrefix pattern).
 *
 * A genuine transport unreachability has NO such line — the session retries.
 * A line matching the agent's stable fatal prefix is a human-action terminal
 * misconfiguration (e.g. daemonHome non-0700) — NO endless retry.
 */

/** Stable prefixes the agent writes before a fatal boot exit. */
export const AGENT_FATAL_PREFIXES = [
  "drishti-agent: fatal: ",
  "drishti-agent --stdio: fatal: ",
  // Legacy single-word form used before the stable prefix (still capture).
  "fatal: ",
] as const;

/**
 * Extract the agent fatal block from remote-origin stderr lines.
 * Returns the message AFTER the prefix (daemonHome text verbatim), or null.
 */
export function extractAgentBootFatal(
  remoteLines: readonly string[],
  prefixes: readonly string[] = AGENT_FATAL_PREFIXES,
): string | null {
  let start = -1;
  let matchedPrefix = "";
  for (let i = remoteLines.length - 1; i >= 0; i--) {
    const line = remoteLines[i] ?? "";
    for (const p of prefixes) {
      if (line.startsWith(p)) {
        start = i;
        matchedPrefix = p;
        break;
      }
    }
    if (start !== -1) break;
  }
  if (start === -1) return null;
  const opening = (remoteLines[start] ?? "").slice(matchedPrefix.length).trimStart();
  const block = [opening, ...remoteLines.slice(start + 1)].join("\n").trim();
  return block.length > 0 ? block : null;
}

/**
 * True when remote stderr shows a terminal agent-boot refusal.
 */
export function isAgentBootRefusal(
  remoteLines: readonly string[],
  prefixes: readonly string[] = AGENT_FATAL_PREFIXES,
): boolean {
  return extractAgentBootFatal(remoteLines, prefixes) !== null;
}
