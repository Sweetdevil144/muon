import { terminalSafe } from "@muon/client";
import type { RecordedEvent } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, green, red, yellow } from "./theme.js";

/**
 * TIMELINE — the ledger, in order (nav destination 7 of 9).
 *
 * The one destination whose data the desk was ALREADY polling and simply had
 * nowhere to put: `BrainSnapshot.events` is refreshed every tick, so this is a
 * pure projection with no new fetch, no new client method and no new failure
 * mode. It was refusing with "not on this desk yet" while holding the answer.
 *
 * WHAT A ROW OWES A HUMAN, and why it is not `kind: message`:
 *
 *  - WHO acted, and under whose accountability. A governance ledger whose rows
 *    do not say whether a human or an agent did the thing is a log, not a
 *    ledger. `principalKind` distinguishes them and `accountablePrincipalId`
 *    names the human answerable for an agent act when the ledger has that
 *    binding — which is the row a post-incident read is actually looking for.
 *  - WHEN, relative to now. An absolute ISO timestamp is unreadable at a
 *    glance and an audit read is nearly always "what happened just before
 *    this". Relative ages sort themselves in the reader's head.
 *  - WHAT, sanitized. `message` and every metadata value are AGENT-AUTHORED
 *    text on a MUON surface, so they flatten through `terminalSafe` like every
 *    other stored string. This is the exact class that has been broken twice
 *    on this desk — a pane that renders ledger text raw hands an agent the
 *    ability to repaint the frame a human is reading its own audit trail in.
 *
 * NEWEST FIRST. The ledger's own order is chronological; a human opening a
 * timeline is asking "what just happened", and making them scroll to the
 * bottom to find it is the same mistake as announcing the newest gate first
 * (which the gate band deliberately does not do — for the opposite reason:
 * there, the oldest is the one costing an agent time).
 */

export type TimelineRow = {
  readonly event: RecordedEvent;
  readonly who: string;
  readonly age: string;
  readonly kind: string;
  readonly message: string;
};

/** Rows built at once. The pane windows to its height on top of this. */
export const TIMELINE_MAX_ROWS = 200;

export type TimelineState = {
  readonly rows: readonly TimelineRow[];
  readonly cursor: number;
  /** Total events the snapshot held, so a bounded view can say it is bounded. */
  readonly total: number;
};

/** `2m`, `3h`, `4d` — bounded, and never a negative age from a skewed clock. */
function ageOf(timestamp: string, now: number): string {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * WHO did this, in the words the ledger actually recorded.
 *
 * Never guesses. A row written before the principal migration carries no
 * principal at all, and the honest rendering of that is "—" rather than
 * "agent" — attributing an unattributed act is exactly the kind of confident
 * wrong answer an audit surface must not produce.
 */
function whoOf(event: RecordedEvent): string {
  const id = event.principalId?.trim();
  if (!id) return "—";
  const kind = event.principalKind;
  const shown = terminalSafe(id);
  const accountable = event.accountablePrincipalId?.trim();
  // An agent act with a human behind it names BOTH: the actor is the agent,
  // the answerable party is the human, and a ledger that showed only one of
  // them would be answering a different question than the reader asked.
  if (kind === "agent" && accountable) {
    return `${shown} (for ${terminalSafe(accountable)})`;
  }
  return shown;
}

/**
 * The newest `limit` events, WITHOUT sorting the whole history.
 *
 * This used to copy the entire event list and sort it on every render — and
 * the brain store's `events` is `eventLists.flat()` with no bound, refreshed
 * every poll. So a long-running task made each repaint of an open timeline
 * progressively more expensive to produce 200 rows, which an adversarial
 * review rightly called out.
 *
 * One pass instead, keeping at most `limit` in descending order and skipping
 * anything older than the worst kept once full. The output is identical; the
 * cost stops depending on how long the mission has been running.
 */
function newestFirst(
  events: readonly RecordedEvent[],
  limit: number
): RecordedEvent[] {
  const kept: Array<{ at: number; event: RecordedEvent }> = [];
  for (const event of events) {
    // An unparseable timestamp sorts oldest rather than being dropped: the row
    // is still a thing that happened, and `ageOf` renders it honestly as "—".
    const at = Date.parse(event.timestamp);
    const key = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    if (kept.length === limit && key <= kept[kept.length - 1]!.at) continue;
    let index = kept.length;
    while (index > 0 && kept[index - 1]!.at < key) index -= 1;
    kept.splice(index, 0, { at: key, event });
    if (kept.length > limit) kept.pop();
  }
  return kept.map((entry) => entry.event);
}

export function buildTimelineRows(
  events: readonly RecordedEvent[],
  now: number
): TimelineState {
  const rows = newestFirst(events, TIMELINE_MAX_ROWS).map((event) => ({
    event,
    who: whoOf(event),
    age: ageOf(event.timestamp, now),
    kind: terminalSafe(event.kind),
    message: terminalSafe(event.message),
  }));
  return { rows, cursor: 0, total: events.length };
}

/** Colour by what the row MEANS, not by which subsystem wrote it. */
function tint(kind: string): (text: string) => string {
  if (kind.includes("fail") || kind.includes("error") || kind.includes("reject")) {
    return red;
  }
  if (kind.includes("approv") || kind.includes("confirm") || kind.includes("done")) {
    return green;
  }
  if (kind.includes("await") || kind.includes("pending") || kind.includes("block")) {
    return yellow;
  }
  return cyan;
}

export class TimelinePane implements Component {
  private readonly state: TimelineState;
  private readonly rows: number;

  constructor(state: TimelineState, rows: number) {
    this.state = state;
    this.rows = Math.max(3, rows);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [
      `${bold(" TIMELINE ")}${dim(
        ` the ledger, newest first · ${this.state.total} event(s)`
      )}`,
      "",
    ];

    if (this.state.rows.length === 0) {
      lines.push(dim("  nothing has happened yet — no ledger events recorded."));
      return lines;
    }

    // WINDOW AROUND THE CURSOR, so a long ledger cannot push the selected row
    // off screen. The same rule the inbox rail uses; stated here because a
    // pane that renders 200 rows into 20 lines silently shows the first 20.
    const body = Math.max(1, this.rows - lines.length - 1);
    const start = Math.max(
      0,
      Math.min(this.state.cursor - Math.floor(body / 2), this.state.rows.length - body)
    );
    const shown = this.state.rows.slice(start, start + body);

    for (const [index, row] of shown.entries()) {
      const selected = start + index === this.state.cursor;
      const marker = selected ? cyan("›") : " ";
      const head = `${marker} ${row.age.padStart(4)} ${tint(row.kind)(row.kind)}`;
      const tail = `${dim(row.who)}  ${row.message}`;
      // Clipped by CODE POINT via the shared fitter upstream; this only bounds
      // the string so one enormous stored message cannot dominate the frame.
      lines.push(`${head}  ${tail}`.slice(0, Math.max(20, width * 4)));
    }

    if (this.state.total > this.state.rows.length) {
      // NEVER a silent truncation: a bounded view that does not say it is
      // bounded reads as "this is everything that happened".
      lines.push(
        dim(
          `  … ${this.state.total - this.state.rows.length} older event(s) not shown`
        )
      );
    }
    return lines;
  }
}
