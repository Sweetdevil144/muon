/**
 * "THE CHILD IS WAITING FOR A BRIEF MUON ALREADY GAVE IT."
 *
 * A vendor CLI that reads stdin when stdin is not a TTY will block on an EOF
 * that never arrives if its parent hands it an open pipe and never closes it.
 * The child looks alive — it has a pid, it may even have printed a banner — and
 * it produces nothing until a watchdog kills it. That is exactly how the
 * founder's mission burned two implementer jobs: `codex exec` had its brief on
 * argv, printed `Reading additional input from stdin...`, and then waited
 * forever. The runner reported an unattributable stall and the coordinator
 * could not tell a killed worker from one that never began.
 *
 * `runLaneCommand` now spawns with stdin on /dev/null, so this state should be
 * unreachable through MUON. This detector is the second line: if it EVER
 * reappears — a new spawn path, a vendor that reads stdin differently, a lane
 * that grows its own transport — the operator gets the cause by name instead of
 * a generic "no output within 90s" and a guess about quota or auth.
 *
 * Deliberately a text signature over what the vendor itself printed, not an
 * inference from silence: silence has many causes and this claim is only made
 * when the child SAID it was reading stdin.
 */

/**
 * Phrases a CLI prints when it is about to read, or is reading, piped stdin.
 * Matched case-insensitively against the child's own combined output.
 *
 * Kept narrow on purpose. A false positive here would misattribute a genuine
 * quota or auth stall to brief delivery, which is the same defect as the
 * generic message it replaces — naming a cause MUON did not observe.
 */
const STDIN_WAIT_SIGNATURES: readonly RegExp[] = [
  // codex 0.145: printed whenever stdin is not a tty, before the turn starts.
  /reading additional input from stdin/i,
  /reading (?:the )?prompt from stdin/i,
  /waiting for (?:input|stdin)/i,
  /reading from stdin/i,
];

/**
 * The one-line cause, or `undefined` when the child never said it was reading
 * stdin. `undefined` means "no evidence", never "not the cause" — the caller
 * keeps its own honest observation in that case.
 */
export function stdinBriefDeliveryStall(
  observed: string
): string | undefined {
  if (!STDIN_WAIT_SIGNATURES.some((pattern) => pattern.test(observed))) {
    return undefined;
  }
  return "The vendor reported that it was reading its prompt from stdin, so it was blocked waiting for input MUON never sends: MUON delivers the brief on argv and gives the child no stdin. This is brief delivery, not quota, auth, or an MCP handshake. Check how this lane spawns its child — stdin must be closed (/dev/null), or the brief must actually be written to it and the stream ended.";
}
