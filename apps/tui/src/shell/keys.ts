import {
  DESK_PREFIX,
  DOWN_KEYS,
  ENTER_KEYS,
  ESC_KEY,
  KEY_QUIT,
  resolveKey,
  SHIFT_TAB_KEY,
  TAB_KEY,
  UP_KEYS,
} from "./keymap.js";
import { topSurface } from "./surfaces.js";

/**
 * The shell's key router — pure, table-driven, and the ONLY place a key
 * becomes an action.
 *
 * Two histories are encoded here and neither may be undone quietly.
 *
 * ONE — the cascade. The Ink desk routes input through a single 500-line
 * `useInput` whose every branch ends in `return`, so a key handled by an
 * earlier mode is swallowed for every later one: Tab dies while the catalogue
 * is open, Esc means different things at different depths, arrows reach one
 * list only. That is the defect class ADR-0042 names and the founder reported
 * (`↑ ↓ Esc Tab broken`). The cure is not more branches: it is a table
 * (`keymap.ts`) plus a LAYER STACK, where an unbound key falls through to the
 * parent scope BY CONSTRUCTION rather than by remembering to omit a `return`.
 *
 * TWO — the prefix. When a vendor CLI owns the pane it owns `q`, `j`, `/`,
 * arrows and ctrl-c. MUON reserves exactly two keys from a child: `ctrl+q`
 * and `ctrl+b`. Everything else is the child's, verbatim. The prefix arms for
 * exactly one keystroke and must not leak — a key that means "crew" after the
 * prefix must never mean "crew" without it.
 *
 * ESC POPS EXACTLY ONE LAYER. Not zero (a dead key is a lie), not two (a
 * human loses their place). The stack is explicit below and each rung has a
 * test.
 */

export type ShellScope = {
  readonly reviewOpen: boolean;
  readonly reviewApprovable: boolean;
  readonly reviewResolving: boolean;
  readonly memoryOpen: boolean;
  readonly memoryBusy: boolean;
  readonly helpOpen: boolean;
  readonly navOpen: boolean;
  readonly spawnMenuOpen: boolean;
  readonly crewOpen: boolean;
  readonly timelineOpen: boolean;
  readonly settingsOpen: boolean;
  readonly sidebarOpen: boolean;
  readonly inboxFocused: boolean;
  readonly inboxHasRows: boolean;
  readonly livePane: boolean;
  readonly governedOpen: boolean;
  readonly corpseOnScreen: boolean;
  /** True when the PREVIOUS keystroke was the desk prefix. */
  readonly prefixArmed: boolean;
  readonly composerOpen: boolean;
  readonly composerBusy: boolean;
};

export type ShellIntent =
  | { kind: "quit" }
  | { kind: "arm-prefix" }
  | { kind: "to-child"; data: string }
  | { kind: "pop-layer" }
  | { kind: "toggle-sidebar" }
  | { kind: "toggle-crew" }
  | { kind: "toggle-inbox" }
  | { kind: "open-help" }
  | { kind: "open-destinations" }
  | { kind: "open-spawn-menu" }
  | { kind: "open-memory" }
  | { kind: "new-tab" }
  | { kind: "next-tab" }
  | { kind: "prev-tab" }
  | { kind: "close-tab" }
  | { kind: "corpse-discard" }
  | { kind: "answer-gate" }
  | { kind: "open-composer" }
  | { kind: "composer-type"; data: string }
  | { kind: "split-pane" }
  | { kind: "focus-pane"; which: "other" | "left" | "right" }
  | { kind: "move"; delta: number }
  | { kind: "cycle-zone"; delta: number }
  | { kind: "activate" }
  | { kind: "review-decide"; status: "approved" | "rejected" }
  | { kind: "memory-act"; action: "confirm" | "reject" | "pause" | "pin" }
  | { kind: "memory-toggle-expired" }
  | { kind: "none" };

/**
 * Which surface owns the keyboard — through the SHARED rule (`surfaces.ts`),
 * not a copy of it. This was the sixth independent precedence chain in the
 * codebase, and the copies had already disagreed once.
 *
 * The router has no reveal-order state (it is pure), so it passes an empty
 * stack: `topSurface` then falls back to its declared order, which is all the
 * ROUTER needs — it only asks "is SOMETHING focused", never "which of two
 * reveals was opened first". The executor, which does own that state, passes
 * the real stack.
 *
 * The `sidebar` is deliberately absent: VISIBLE IS NOT FOCUSED. A rail that
 * accepts no input is not a surface, and listing it here made the overlay
 * branch swallow every key meant for a live terminal.
 */
export function topLayer(scope: ShellScope): string | null {
  const surface = topSurface(
    {
      composer: scope.composerOpen,
      review: scope.reviewOpen,
      memory: scope.memoryOpen,
      help: scope.helpOpen,
      "spawn-menu": scope.spawnMenuOpen,
      destinations: scope.navOpen,
      crew: scope.crewOpen,
      timeline: scope.timelineOpen,
      settings: scope.settingsOpen,
      inbox: scope.inboxFocused,
    },
    []
  );
  if (surface) return surface;
  if (scope.governedOpen) return "governed";
  return null;
}

function moveDelta(data: string): number | null {
  if ((DOWN_KEYS as readonly string[]).includes(data)) return 1;
  if ((UP_KEYS as readonly string[]).includes(data)) return -1;
  return null;
}

const isEnter = (data: string) => (ENTER_KEYS as readonly string[]).includes(data);

/**
 * A prefix ACTION as the desk's own intent.
 *
 * Exported because the footer's clickable hints carry keymap ACTION strings,
 * and the first version of that feature cast one straight to a `ShellIntent`.
 * The two vocabularies are not the same — `focus-other-pane` is an action but
 * the intent is `{kind: "focus-pane", which: "other"}` — so the advertised
 * `ctrl+b o focus` hint reached no branch and did nothing when clicked. A
 * chord's meaning has one definition, and this is it.
 */
export function intentForAction(action: string): ShellIntent {
  switch (action) {
    // ALWAYS-scope, included because the footer advertises it as a clickable
    // hint. `resolveKey("prefix", …)` can never return it — quit is not a
    // prefix chord — so this widens nothing for the keyboard. Walking EVERY
    // hint found this one inert too; the reported bug was one of two.
    case "quit": return { kind: "quit" };
      case "toggle-sidebar": return { kind: "toggle-sidebar" };
      case "toggle-crew": return { kind: "toggle-crew" };
      case "toggle-inbox": return { kind: "toggle-inbox" };
      case "open-destinations": return { kind: "open-destinations" };
      case "open-memory": return { kind: "open-memory" };
      case "open-help": return { kind: "open-help" };
      case "new-tab": return { kind: "new-tab" };
      case "next-tab": return { kind: "next-tab" };
      case "prev-tab": return { kind: "prev-tab" };
      case "close-tab": return { kind: "close-tab" };
      case "answer-gate": return { kind: "answer-gate" };
      case "open-composer": return { kind: "open-composer" };
      case "split-pane": return { kind: "split-pane" };
      case "focus-other-pane": return { kind: "focus-pane", which: "other" };
      case "focus-left-pane": return { kind: "focus-pane", which: "left" };
      case "focus-right-pane": return { kind: "focus-pane", which: "right" };
      default: return { kind: "none" };
    }
}

export function routeKey(data: string, scope: ShellScope): ShellIntent {
  // ── 1. ALWAYS. Two keys, reserved from every scope INCLUDING a child.
  if (data === KEY_QUIT) return { kind: "quit" };

  // ── 2. THE PREFIX, if armed. Exactly one keystroke, then the caller
  // disarms. An unrecognised key here is a no-op, NOT a fall-through to the
  // child: leaking is how a prefix acquires meanings it never advertised.
  if (scope.prefixArmed) {
    return intentForAction(resolveKey("prefix", data) ?? "");
  }

  if (data === DESK_PREFIX) return { kind: "arm-prefix" };

  // ── 2c. THE COMPOSER is a text field, so it owns nearly everything: a
  // human typing a task title must be able to type "q", "j" and "/" without
  // the desk interpreting them. Only Esc, Enter and the arrows are ours.
  if (scope.composerOpen) {
    if (data === ESC_KEY) return { kind: "pop-layer" };
    if (scope.composerBusy) return { kind: "none" };
    if (isEnter(data)) return { kind: "activate" };
    if (data === `${ESC_KEY}[B`) return { kind: "move", delta: 1 };
    if (data === `${ESC_KEY}[A`) return { kind: "move", delta: -1 };
    return { kind: "composer-type", data };
  }

  // ── 3. A GATE owns the keyboard. Nothing falls through: a stray key must
  // not quit, spawn or navigate behind a human who is reading a gate.
  if (scope.reviewOpen) {
    if (data === ESC_KEY) return { kind: "pop-layer" };
    if (scope.reviewResolving || !scope.reviewApprovable) return { kind: "none" };
    if (data === "a") return { kind: "review-decide", status: "approved" };
    if (data === "r") return { kind: "review-decide", status: "rejected" };
    return { kind: "none" };
  }
  if (scope.memoryOpen) {
    if (data === ESC_KEY) return { kind: "pop-layer" };
    if (scope.memoryBusy) return { kind: "none" };
    const delta = moveDelta(data);
    if (delta !== null) return { kind: "move", delta };
    if (data === "e") return { kind: "memory-toggle-expired" };
    if (data === "c") return { kind: "memory-act", action: "confirm" };
    if (data === "x") return { kind: "memory-act", action: "reject" };
    if (data === "p") return { kind: "memory-act", action: "pause" };
    if (data === "P") return { kind: "memory-act", action: "pin" };
    return { kind: "none" };
  }

  // ── 4. OVERLAYS. Esc pops ONE; arrows move; Tab cycles — including with
  // the catalogue open, which is the founder's reported break.
  const layer = topLayer(scope);
  if (layer !== null && layer !== "governed") {
    if (data === ESC_KEY) return { kind: "pop-layer" };
    if (data === TAB_KEY) return { kind: "cycle-zone", delta: 1 };
    if (data === SHIFT_TAB_KEY) return { kind: "cycle-zone", delta: -1 };
    const delta = moveDelta(data);
    if (delta !== null) return { kind: "move", delta };
    if (isEnter(data)) return { kind: "activate" };
    return { kind: "none" };
  }

  // ── 4b. A RESTORED CORPSE advertises two keys on its own face: Enter to
  // start a new session here, and `x` to discard it. `x` lost its handler in
  // the router rewrite and became inert — the exact "advertised but does
  // nothing" the drift-lock exists to forbid, hiding on a surface the lock
  // did not cover because a corpse is not a prefix command.
  // `!livePane` is not redundant. The executor keeps these mutually exclusive
  // today (a live pane outranks a corpse in `centreKind`), but this router is
  // a PURE function and must not depend on an invariant maintained somewhere
  // else — that dependency is precisely the "contradictory state" a review
  // warned about. An audit over every passive flag found `x` reaching this
  // branch with a pane live, which would have eaten a keystroke the child
  // owns.
  if (!scope.livePane && scope.corpseOnScreen && data === "x") {
    return { kind: "corpse-discard" };
  }

  // ── 5. A LIVE PANE owns everything else — `q`, ctrl-c, arrows, Tab. This
  // sits ABOVE the cockpit deliberately: with the cockpit's quit first,
  // typing `q` at a shell prompt killed the desk and every child with it.
  if (scope.livePane) return { kind: "to-child", data };

  // ── 6. A governed attach is a VIEW: q/esc close the view, not the desk.
  if (scope.governedOpen && (data === "q" || data === ESC_KEY)) {
    return { kind: "pop-layer" };
  }

  // ── 7. THE COCKPIT. No child, so bare keys are safe here.
  if (data === ESC_KEY) return { kind: "none" };
  if (data === TAB_KEY) return { kind: "cycle-zone", delta: 1 };
  if (data === SHIFT_TAB_KEY) return { kind: "cycle-zone", delta: -1 };
  const delta = moveDelta(data);
  if (delta !== null) return { kind: "move", delta };
  if (isEnter(data)) return { kind: "activate" };
  switch (resolveKey("desk", data)) {
    case "open-spawn-menu": return { kind: "open-spawn-menu" };
    case "quit": return { kind: "quit" };
    default: return { kind: "none" };
  }
}
