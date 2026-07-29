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
 * Extract the agent fatal MESSAGE from remote-origin stderr lines.
 *
 * VERBATIM (U2.4): only the payload of the prefixed fatal line — never the
 * stack/diagnostic tail that follows on subsequent lines. The stack may ride a
 * separate field later; it must not substitute for `message`.
 */
export function extractAgentBootFatal(
  remoteLines: readonly string[],
  prefixes: readonly string[] = AGENT_FATAL_PREFIXES,
): string | null {
  for (let i = remoteLines.length - 1; i >= 0; i--) {
    const line = remoteLines[i] ?? "";
    for (const p of prefixes) {
      if (line.startsWith(p)) {
        // U3.5: exact post-prefix slice — do NOT trimStart a nonempty payload
        // (leading whitespace in the fatal message is part of verbatim).
        const message = line.slice(p.length);
        if (message.trim().length === 0) return null;
        return message;
      }
    }
  }
  return null;
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
