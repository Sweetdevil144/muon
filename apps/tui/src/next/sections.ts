/**
 * ADR-0042 D3/D7 — section geometry for the new desk.
 *
 * Four properties a dense rail needs, none of which the old screen had:
 *
 *   1. The rail is a list of SECTIONS with computed heights and a divider
 *      between them — not one flat list.
 *   2. Each section is CLIPPED to its own body rather than allowed to push its
 *      neighbour off the screen.
 *   3. Every row carries a status glyph resolved ONCE, not a sentence.
 *   4. Long labels truncate to the column budget.
 *
 * The old MUON screen had none of them: five regions stacked at equal weight,
 * each printing everything it held, so a rail with 12 agents pushed the work
 * list off the bottom and load-bearing sentences truncated mid-word instead of
 * the region shrinking.
 *
 * Pure geometry. No Ink, no React, no data fetching — so it is testable, and so
 * it survives the substrate change ADR-0042 D1 describes.
 */

export type Section<T> = {
  readonly id: string;
  /** Shown uppercase in the rail. Kept short; it is a label, not a sentence. */
  readonly title: string;
  readonly rows: readonly T[];
  /**
   * Rows to show before this section yields space to the next. A section never
   * borrows height from its neighbour — that is what stops one long list from
   * pushing everything else off the screen.
   */
  readonly maxRows?: number;
};

export type LaidOutSection<T> = {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly T[];
  /** Rows that did not fit. Rendered as a count, never silently dropped. */
  readonly hidden: number;
};

/**
 * Distribute `available` lines across sections.
 *
 * Each section costs one line for its title. Space is handed out in ROUNDS —
 * every section takes one row per round until it is satisfied or the budget
 * runs out — so a 12-agent fleet cannot starve a 2-item inbox. Fixed
 * per-section heights would reach the same outcome; rounds get there without a
 * configuration surface, which MUON does not need yet.
 *
 * Overflow is REPORTED (`hidden`), never hidden. A rail that shows 8 of 12
 * agents and says nothing is lying about the size of the fleet.
 */
export function layoutSections<T>(
  sections: readonly Section<T>[],
  available: number
): LaidOutSection<T>[] {
  const visible = sections.filter((section) => section.rows.length > 0);
  if (visible.length === 0) return [];

  // One line per title, and one blank between sections.
  const chrome = visible.length + Math.max(0, visible.length - 1);
  let budget = Math.max(0, available - chrome);

  const taken = new Map<string, number>();
  for (const section of visible) taken.set(section.id, 0);

  let progressed = true;
  while (budget > 0 && progressed) {
    progressed = false;
    for (const section of visible) {
      if (budget === 0) break;
      const current = taken.get(section.id) ?? 0;
      const ceiling = Math.min(
        section.rows.length,
        section.maxRows ?? section.rows.length
      );
      if (current >= ceiling) continue;
      taken.set(section.id, current + 1);
      budget -= 1;
      progressed = true;
    }
  }

  return visible.map((section) => {
    const count = taken.get(section.id) ?? 0;
    return {
      id: section.id,
      title: section.title,
      rows: section.rows.slice(0, count),
      hidden: section.rows.length - count,
    };
  });
}

/**
 * Truncate to a column budget, with an ellipsis that REPLACES a character
 * rather than overflowing past the width.
 *
 * The old screen truncated load-bearing sentences mid-word (`Cursor is a m…`),
 * which tells the reader there is something they are not being shown and gives
 * them no way to see it. ADR-0042 D7's rule is that such text does not belong
 * on the main screen at all — this exists for LABELS, where the full value is
 * always reachable by selecting the row.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

/**
 * A row's status, as ONE glyph and ONE word (D7).
 *
 * Resolved once per row and rendered as the key, never a sentence. The old
 * MUON rail printed a `○` for every agent
 * regardless of state, so twelve identical circles carried no information at
 * all — the fleet looked the same whether it was idle or on fire.
 */
export type RowStatus =
  | "blocked"
  | "failed"
  | "working"
  | "done"
  | "idle"
  | "unknown";

const GLYPH: Record<RowStatus, string> = {
  blocked: "◍",
  failed: "✗",
  working: "▶",
  done: "✓",
  idle: "○",
  unknown: "·",
};

/** Attention order: what a person should look at first (ADR-0032 D3). */
const WEIGHT: Record<RowStatus, number> = {
  blocked: 0,
  failed: 1,
  working: 2,
  done: 3,
  idle: 4,
  unknown: 5,
};

export function statusGlyph(status: RowStatus): string {
  return GLYPH[status];
}

/**
 * Sort by attention, stably.
 *
 * Stability matters more than it looks: an unstable sort makes the rail
 * reshuffle on every 2s poll, and a list that moves under the cursor is one
 * nobody can use.
 */
export function byAttention<T>(
  rows: readonly T[],
  statusOf: (row: T) => RowStatus
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const delta = WEIGHT[statusOf(left.row)] - WEIGHT[statusOf(right.row)];
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map((entry) => entry.row);
}

/**
 * The one-line header summary: what is happening, in counts.
 *
 * Replaces the five-line DOCTOR block. A degraded runner is a real fact and it
 * belongs in the INBOX (a thing needing a person), not as four permanent lines
 * of chrome above every screen.
 */
export function headline(counts: {
  running: number;
  blocked: number;
  failed: number;
  needsYou: number;
}): string {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.needsYou > 0) parts.push(`${counts.needsYou} needs you`);
  return parts.length > 0 ? parts.join(" · ") : "idle";
}

/**
 * Does the left rail own the cursor right now?
 *
 * A highlight is a CLAIM about where your next keypress lands. The rail's
 * cursor and the palette's cursor derive from the same `selected` state, so
 * with a modal scope open an arrow key stepped both and two rows glowed at
 * once — leaving it ambiguous what Enter would act on (founder-reported).
 *
 * Extracted as a pure predicate deliberately: `ink-testing-library`'s
 * `lastFrame()` strips ANSI, so a colour-only highlight is INVISIBLE to a
 * rendered-frame assertion. A test written against the frame cannot fail when
 * this rule breaks — it has to be tested here.
 *
 * The scope set is the same one the key dispatcher uses to choose a scope, so
 * the highlight and the handler cannot disagree about who is in charge.
 */
export function railOwnsCursor(input: {
  readonly paletteOpen: boolean;
  readonly formOpen: boolean;
  readonly reviewOpen: boolean;
  readonly memoryOpen: boolean;
}): boolean {
  return (
    !input.paletteOpen &&
    !input.formOpen &&
    !input.reviewOpen &&
    !input.memoryOpen
  );
}
