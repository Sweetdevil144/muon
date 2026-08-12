/**
 * THE THING THAT READS YOUR KEYSTROKES BEFORE ANYTHING ELSE SEES THEM.
 *
 * A terminal does not hand a program one keystroke per read. It hands it
 * whatever bytes happened to be in the pipe. Usually that is exactly one
 * keystroke, which is why this is easy to get away with omitting — and why the
 * failure, when it comes, looks like "shortcuts work, except sometimes".
 *
 * `ctrl+b s` under the kitty protocol is `ESC [ 98 ; 5 u`. If the read boundary
 * lands mid-sequence the desk previously saw two chunks:
 *
 *     ESC [ 98 ;        -> not a sequence MUON knows, forwarded to the child
 *     5 u               -> not a sequence at all, TYPED into the child as "5u"
 *
 * The chord silently does nothing and two junk characters appear in the pane.
 * It depends on timing and on how much else is in the pipe, so it presents as
 * flakiness rather than as a bug — the founder's exact worry, and the reason
 * this is a bounded reader rather than a bigger buffer.
 *
 * TWO GUARANTEES, both tested:
 *
 *   LIVENESS  pending bytes are ALWAYS released — on the next read, on the
 *             timer, or on the size bound. Nothing can wedge here and leave
 *             every later shortcut dead, which is the failure mode that would
 *             be hardest for a user to describe and hardest for us to find.
 *
 *   BOUNDED   pending never exceeds `maxPending`. There is no input, hostile
 *             or accidental, that grows this buffer without limit.
 *
 * Only a TRAILING incomplete sequence is ever held. Everything before it is
 * emitted immediately, so a paste — which is a complete `ESC[200~` followed by
 * a body — flows straight through instead of accumulating.
 */

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

/**
 * How long to wait for the rest of a sequence before deciding there isn't one.
 *
 * This is the classic ESCDELAY trade-off: a lone ESC is ambiguous — it is
 * either the Escape key or the first byte of a chord whose tail has not
 * arrived. 25ms is below the threshold of perception for Escape and far longer
 * than the gap between two reads of one keystroke.
 */
const DEFAULT_ESC_DELAY_MS = 25;

/**
 * The size bound. Generous enough for any real sequence (the longest a host
 * sends is a device-attributes or colour report, well under 100 bytes) and
 * small enough that holding it costs nothing.
 */
const DEFAULT_MAX_PENDING = 1024;

export type KeyStreamOptions = {
  escDelayMs?: number;
  maxPending?: number;
  /** Injected so the timing is testable without waiting in real time. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export class KeyStreamReader {
  private pending = "";
  private timer: unknown;
  private readonly escDelayMs: number;
  private readonly maxPending: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly emit: (data: string) => void,
    options: KeyStreamOptions = {}
  ) {
    this.escDelayMs = options.escDelayMs ?? DEFAULT_ESC_DELAY_MS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // A 25ms key-delay must never be the reason a process stays alive.
        handle.unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  /** Feed one raw read from the terminal. */
  push(chunk: string): void {
    this.disarm();
    this.pending += chunk;

    // The bound comes FIRST. Whatever this is, it is not a key sequence any
    // more, and holding it would only delay the inevitable.
    if (this.pending.length > this.maxPending) {
      this.release();
      return;
    }

    const cut = trailingPartialAt(this.pending);
    if (cut > 0) this.deliver(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
    if (this.pending.length > 0) {
      this.timer = this.setTimer(() => this.release(), this.escDelayMs);
    }
  }

  /**
   * Release whatever is held, now. Called by the timer, and on shutdown so a
   * half-typed sequence is not swallowed on the way out.
   */
  release(): void {
    this.disarm();
    const held = this.pending;
    this.pending = "";
    this.deliver(held);
  }

  /** Held bytes, for tests and for asserting the liveness guarantee. */
  get held(): string {
    return this.pending;
  }

  private deliver(data: string): void {
    if (data.length > 0) this.emit(data);
  }

  private disarm(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Where the trailing incomplete escape sequence begins, or the buffer length
 * if there isn't one.
 *
 * Exported because this is the whole decision — everything else in the class is
 * bookkeeping around it — and it is far easier to pin as a pure function.
 */
export function trailingPartialAt(buffer: string): number {
  const start = buffer.lastIndexOf(ESC);
  if (start === -1) return buffer.length;
  return isIncomplete(buffer.slice(start)) ? start : buffer.length;
}

/**
 * Could these bytes still become a longer sequence?
 *
 * Deliberately conservative: anything MALFORMED is reported complete, so it is
 * emitted and dealt with downstream rather than held here. A reader that waits
 * for a sequence that can never arrive is exactly the wedge this must not have.
 */
function isIncomplete(tail: string): boolean {
  if (tail.length === 1) return true; // lone ESC — the timer decides
  const kind = tail[1]!;

  // CSI: parameter and intermediate bytes, then a final byte 0x40-0x7E.
  if (kind === "[") {
    for (let index = 2; index < tail.length; index += 1) {
      const code = tail.codePointAt(index)!;
      if (code >= 0x40 && code <= 0x7e) return false; // final byte — complete
      if (code < 0x20 || code > 0x3f) return false; // malformed — let it go
    }
    return true;
  }

  // SS3: exactly one byte follows.
  if (kind === "O") return tail.length < 3;

  // OSC / DCS / APC / PM / SOS: a string, terminated by BEL or ST (ESC \).
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
    return !tail.includes(BEL) && !tail.slice(1).includes(`${ESC}\\`);
  }

  // ESC + anything else is a complete two-byte sequence (alt+key).
  return false;
}

/**
 * How many characters the FIRST keystroke in this buffer occupies.
 *
 * The reader above guarantees a chunk holds only COMPLETE sequences; it makes
 * no promise that it holds only one. `ctrl+b` and its command key are typed a
 * fraction of a second apart, so a terminal routinely delivers both in one
 * read — `\x02s`, or `ESC[98;5us` before normalization. Anything that has to
 * act on the first key of such a read needs to know where it ends.
 */
export function firstKeystrokeLength(data: string): number {
  if (data.length === 0) return 0;
  if (data[0] !== ESC) {
    // Surrogate-safe: an emoji is one keystroke, not two characters.
    return [...data][0]!.length;
  }
  if (data.length === 1) return 1;
  const kind = data[1]!;

  if (kind === "[") {
    for (let index = 2; index < data.length; index += 1) {
      const code = data.codePointAt(index)!;
      if (code >= 0x40 && code <= 0x7e) return index + 1; // final byte
      if (code < 0x20 || code > 0x3f) return index; // malformed: it ends here
    }
    return data.length;
  }
  if (kind === "O") return Math.min(3, data.length);
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
    const bel = data.indexOf(BEL);
    const st = data.indexOf(`${ESC}\\`, 1);
    if (bel !== -1 && (st === -1 || bel < st)) return bel + 1;
    if (st !== -1) return st + 2;
    return data.length;
  }
  return 2; // ESC + key (alt+…)
}
