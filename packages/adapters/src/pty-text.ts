// Text recovery for vendor output that arrived through a REAL pty.
//
// A pty carries the vendor's native console rendering — ANSI colour, cursor
// movement, spinner redraws — which is exactly what the live terminal viewer
// wants, byte-for-byte. Everything DOWNSTREAM of the run, though, still needs
// the plain text it always parsed from pipes: `parseWorkerFinalReport` anchors
// on `^GOAL:` and friends, token-usage extraction matches literal labels, and
// the recorded stream renders as text. One `\x1b[1m` in front of a label, or a
// spinner's carriage-return overdraws left in place, would silently drop a
// final report. These helpers recover that plain text; the raw bytes flow to
// the live sink untouched.

/** CSI/OSC/charset escapes; the same classes sanitizePromptForPty-style code
 *  strips, matched WHOLE so their printable payloads don't leak as garbage. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN =
  // CSI … final byte | OSC … BEL/ST | ESC + optional intermediate + final
  // (covers Fe escapes, charset selection `ESC ( B`, keypad `ESC =`, RIS).
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x9b[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]?[0-~]/g;

/** Strip ANSI escape sequences from a COMPLETE string. Not chunk-safe: an
 *  escape split across two chunks survives both halves — use it on the fully
 *  accumulated output, never per-chunk. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Recover plain line-oriented text from accumulated pty output.
 *
 * Beyond stripping escapes, a tty stream overdraws lines in place: a spinner
 * writes `⠋ thinking…\r⠙ thinking…\r` and only the LAST write is what a human
 * ever saw. Emulate exactly that — within each `\n`-terminated line, keep only
 * the content after the final `\r` — then drop the control characters that
 * have no place in parsed text. `\t` survives (real output uses it).
 */
export function normalizePtyOutput(raw: string): string {
  const stripped = stripAnsi(raw.replace(/\r\n/g, "\n"));
  return (
    stripped
      .split("\n")
      .map((line) => {
        const overdraw = line.lastIndexOf("\r");
        return overdraw >= 0 ? line.slice(overdraw + 1) : line;
      })
      .join("\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

/**
 * The shape both vendors' session ids actually take (codex rollout id, Claude
 * session uuid). It is the CONTRACT of the backlink column, whose one consumer
 * is a `--resume`/`resume` argv — so anything else is refused at every hop
 * rather than 400ing at the brain and silently costing the job its resume
 * handle.
 */
const VENDOR_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** True for a vendor session id MUON is willing to record and later resume. */
export function isVendorSessionId(value: string | undefined | null): boolean {
  return typeof value === "string" && VENDOR_SESSION_ID_PATTERN.test(value.trim());
}

/**
 * The vendor session id printed in codex's own exec banner
 * (`session id: 019fa043-…`, verified live against codex 0.145.0), recovered
 * from raw pty bytes. Null until the banner has actually arrived — the caller
 * treats that as "not known yet", never as an error.
 */
export function codexSessionIdFromOutput(raw: string): string | null {
  const match = /session id:\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i.exec(
    normalizePtyOutput(raw)
  );
  return match ? match[1]!.toLowerCase() : null;
}
