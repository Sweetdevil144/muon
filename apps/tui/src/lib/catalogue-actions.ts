import type { CatalogueEntry } from "./catalogue.js";

/**
 * ADR-0042 D6, second half — the catalogue EXECUTES what it lists.
 *
 * One pure resolver from a catalogue entry to a typed action the new desk can
 * interpret. Renderer-agnostic on purpose: the mapping is data + a function,
 * so it survives the substrate change (D1) and is testable without Ink.
 *
 * THE UNION IS THE GOVERNANCE BOUNDARY. No action type here DECIDES anything:
 * none resolves an approval, dispatches work, mints a receipt, or writes
 * memory. `review-approval` OPENS the evidence; the decision is a second
 * press inside the review scope, bound to the approval on screen. Verbs whose
 * gate is still absent from this desk (the run/dispatch path, the memory
 * gate) remain UNREPRESENTABLE here rather than guarded at call time — same
 * construction as the flake ledger's write schema (the abusable label is not
 * in the vocabulary) and the brain gate's confirmed-only fields.
 *
 * The rule that governs growth: an action type is added WITH the surface that
 * carries its evidence, never before. `review-approval` waited for the review
 * overlay; `form` waited for the form scope. Both were `focus`/`elsewhere`
 * until the day their surface existed.
 *
 * The command table is a CLOSED, positive list (bounded-surface completeness):
 * an id the table does not name falls through to `elsewhere` — the honest
 * refusal — never to the nearest-looking verb.
 */

/** Zones this desk actually has. Not the classic desk's five focus zones. */
export type DeskZone = "crew" | "inbox";

/** Commands whose form the desk can OPEN — exactly the set that HAS a submit
 *  path: `task-new`/`assign`/`status` through `executeAction`, and `run`
 *  through `dispatchRun` (a dispatch is not a ledger write and does not go
 *  through the same seam). Adding a kind here without a submit path makes the
 *  desk lie; the resolver test pins the pairing for both seams. */
export type CatalogueFormKind =
  | "task-new"
  | "assign"
  | "status"
  | "run"
  | "memory-search";

export type CatalogueAction =
  /** Close the TUI. */
  | { readonly type: "quit" }
  /** Re-poll the brain now. */
  | { readonly type: "refresh" }
  /** Move the cursor's zone. `note` explains when focus is a consolation —
   *  e.g. approve/reject focus the inbox instead of deciding. */
  | { readonly type: "focus"; readonly zone: DeskZone; readonly note?: string }
  /** Open the command's FORM (the form scope is ported; `executeAction`
   *  submits it through the governed client — same path the classic desk
   *  uses, so cross-surface parity holds by construction). */
  | { readonly type: "form"; readonly form: CatalogueFormKind }
  /**
   * Open the approval REVIEW for the selected request — evidence first, the
   * decision on a second press (ADR-0032 D5).
   *
   * Added WITH the surface that carries it, which is the whole rule this
   * union was built around: while the new desk had no review overlay,
   * approve/reject resolved to `focus` and a decision was UNREPRESENTABLE
   * here rather than guarded at call time. The overlay exists now, so the
   * verb exists now — not before, and not without it.
   */
  | { readonly type: "review-approval"; readonly decision: "approve" | "reject" }
  /** Real, runnable — but its surface is not on THIS desk yet. The reason
   *  names where it does run, so the refusal is a direction, not a wall. */
  | { readonly type: "elsewhere"; readonly reason: string }
  /** The entry itself says it cannot run right now (`enabled: false`). */
  | { readonly type: "disabled"; readonly reason: string };

// Kept SHORT on purpose: a refusal renders on the one-line status footer,
// and a governance explanation that truncates at 80 columns explains
// nothing (review pass 7 #9). ≤48 chars each, label clipped separately.
// The PREVIOUS desk's launch command. This constant briefly said `npm run
// tui` after the default flip — which made every refusal on the new desk
// point the user at the desk that had just refused them. A refusal's whole
// value is the direction it gives; a wrong direction is worse than none.
const CLASSIC = "npm run tui:legacy";

/** The classic-desk surfaces, named once so every refusal points somewhere. */
const NOT_PORTED: Record<string, string> = {
  "task-ledger": `task ledger — classic desk: ${CLASSIC}`,
  handoffs: `handoffs — classic desk: ${CLASSIC}`,
  form: `needs a form — classic desk: ${CLASSIC}`,
  overlay: `a classic-desk panel — ${CLASSIC}`,
  session: `live sessions — classic desk: ${CLASSIC}`,
};

/**
 * Approve and reject OPEN THE REVIEW; they never decide. The evidence (and,
 * for a merge, the coverage certification) is what a second press acts on —
 * the same two-press rule the classic desk and the desktop gate use, so a
 * decision is always bound to the approval a human just read rather than to
 * a list index that a 2s poll may have moved.
 */

const COMMAND_ACTIONS: Record<string, CatalogueAction> = {
  quit: { type: "quit" },
  refresh: { type: "refresh" },
  "focus-approvals": { type: "focus", zone: "inbox" },
  "focus-lanes": { type: "focus", zone: "crew" },
  "focus-tasks": { type: "elsewhere", reason: NOT_PORTED["task-ledger"]! },
  "focus-handoffs": { type: "elsewhere", reason: NOT_PORTED["handoffs"]! },
  approve: { type: "review-approval", decision: "approve" },
  reject: { type: "review-approval", decision: "reject" },
  // The form scope is ported for exactly the commands executeAction submits.
  "task-new": { type: "form", form: "task-new" },
  assign: { type: "form", form: "assign" },
  status: { type: "form", form: "status" },
  run: { type: "form", form: "run" },
  // Ported: the results pane reuses the classic desk's `MemoryPanel`, so the
  // confirmed/vouched/expired markers cannot drift between the two desks.
  "memory-search": { type: "form", form: "memory-search" },
  "memory-add": { type: "elsewhere", reason: NOT_PORTED["form"]! },
  context: { type: "elsewhere", reason: NOT_PORTED["overlay"]! },
  crew: { type: "elsewhere", reason: NOT_PORTED["overlay"]! },
  mcp: { type: "elsewhere", reason: NOT_PORTED["overlay"]! },
  quickstart: { type: "elsewhere", reason: NOT_PORTED["overlay"]! },
  "session-start": { type: "elsewhere", reason: NOT_PORTED["session"]! },
  "session-send": { type: "elsewhere", reason: NOT_PORTED["session"]! },
  "session-interrupt": { type: "elsewhere", reason: NOT_PORTED["session"]! },
  "take-over": { type: "elsewhere", reason: NOT_PORTED["session"]! },
  "return-session": { type: "elsewhere", reason: NOT_PORTED["session"]! },
  ship: { type: "elsewhere", reason: NOT_PORTED["overlay"]! },
  plan: { type: "elsewhere", reason: NOT_PORTED["form"]! },
  workflows: { type: "elsewhere", reason: NOT_PORTED["overlay"]! },
  specialist: { type: "elsewhere", reason: NOT_PORTED["form"]! },
};

export function resolveCatalogueAction(entry: CatalogueEntry): CatalogueAction {
  if (!entry.enabled) {
    return {
      type: "disabled",
      reason: entry.badge
        ? `not ready (${entry.badge})`
        : "not ready to run right now",
    };
  }

  switch (entry.kind) {
    case "harness":
      return {
        type: "elsewhere",
        reason: `applies at dispatch — classic desk: ${CLASSIC}`,
      };
    case "agent":
      return {
        type: "elsewhere",
        reason: "launches from the desktop app — UNGOVERNED there too",
      };
    case "workflow":
      return { type: "elsewhere", reason: NOT_PORTED["overlay"]! };
    case "command":
      break;
  }

  const id = entry.id.startsWith("command:")
    ? entry.id.slice("command:".length)
    : entry.id;

  if (id.startsWith("vendor:")) {
    return {
      type: "elsewhere",
      reason: `via the command bar — classic desk: ${CLASSIC}`,
    };
  }

  // Closed table; anything unnamed refuses honestly rather than guessing.
  // `Object.hasOwn`, not a bare index: a bare lookup walks the prototype
  // chain, so an id like "constructor" or "toString" would return a Function
  // instead of falling through — the closed list would not actually be
  // closed. Unreachable from today's static command sources, guarded anyway
  // (bounded-surface completeness; same move as detection-manifest.ts).
  return Object.hasOwn(COMMAND_ACTIONS, id)
    ? COMMAND_ACTIONS[id]!
    : {
        type: "elsewhere",
        reason: `not on this desk yet — ${CLASSIC}`,
      };
}
