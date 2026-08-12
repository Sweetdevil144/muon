/**
 * WHICH SURFACE IS ON TOP — the one rule, in one place.
 *
 * A review named the defect precisely: "its many nullable and boolean fields
 * require duplicated precedence logic across `centreKind`, `topLayer`,
 * `moveFocused`, and `cycleZone`, making contradictory state and future
 * regressions increasingly likely." That was already true twice over — the
 * `pop-layer` handler carried a fifth copy, and the copies had already
 * DISAGREED once: `topLayer` used a fixed precedence while the docstring (and
 * a human's expectation) said reveal order, so opening the crew drawer then
 * the inbox and pressing Esc closed the crew drawer.
 *
 * So the precedence is a function now, not a pattern. Everything that needs
 * to know what is on top calls `topSurface`, and there is exactly one place
 * to change if the order ever changes.
 *
 * TWO TIERS, and the split is the whole design:
 *
 *  - GATES (`composer`, `review`, `memory`) are always innermost, in a fixed
 *    order, because they own the keyboard by definition: a human is reading
 *    evidence or typing into a field, and nothing revealed earlier may take a
 *    keystroke from them.
 *  - REVEALS (`help`, `spawn-menu`, `destinations`, `crew`, `inbox`) pop in
 *    the order they were opened, most recent first, because that is what a
 *    human means by "go back".
 *
 * The `sidebar` is deliberately ABSENT from both. It is visible, not focused:
 * a rail that accepts no input is not a surface, and listing it here is what
 * made it swallow every keystroke meant for a live terminal.
 */

export type GateSurface = "composer" | "review" | "memory";
export type RevealSurface =
  | "help"
  | "spawn-menu"
  | "destinations"
  | "crew"
  | "timeline"
  | "settings"
  | "inbox";
export type Surface = GateSurface | RevealSurface;

/** Innermost first. A gate outranks every reveal, whenever it opened. */
export const GATE_ORDER: readonly GateSurface[] = [
  "composer",
  "review",
  "memory",
];

export type SurfaceFlags = Readonly<Record<Surface, boolean>>;

/**
 * The surface that owns the keyboard, or null when the desk itself does.
 *
 * `revealStack` is most-recent-last. A reveal that is on the stack but no
 * longer open is ignored rather than trusted, so a stale entry cannot make
 * this disagree with the flags — the flags are the truth, the stack is only
 * the ordering.
 */
export function topSurface(
  flags: SurfaceFlags,
  revealStack: readonly RevealSurface[]
): Surface | null {
  for (const gate of GATE_ORDER) {
    if (flags[gate]) return gate;
  }
  for (let index = revealStack.length - 1; index >= 0; index -= 1) {
    const candidate = revealStack[index]!;
    if (flags[candidate]) return candidate;
  }
  // A reveal opened without touching the stack still counts — otherwise a
  // missed `noteReveal` would make a visible surface unreachable and
  // un-poppable, which is a worse failure than a wrong order.
  const orphan = REVEAL_ORDER.find((name) => flags[name]);
  return orphan ?? null;
}

/**
 * The fallback order, and the reason it is a checked constant rather than an
 * inline array.
 *
 * It WAS an inline array, and adding `timeline` and `settings` to
 * `RevealSurface` did not add them here — so `routeKey`, which asks
 * `topSurface` with an empty stack and therefore depends entirely on this
 * list, did not recognise either overlay. With a live pane underneath, arrows
 * and Enter fell straight through to the CHILD while the overlay was drawn on
 * top: a human navigating a settings list would have been typing into someone
 * else's editor. That is the same "visible is not focused" class this file
 * exists to hold, arriving through the one path nobody re-derived.
 *
 * The `Exclude<…> extends never` line below is the actual fix. A new
 * `RevealSurface` that is not listed here is now a TYPE ERROR, not a silent
 * hole — which is the only version of this that survives the next surface.
 */
const REVEAL_ORDER = [
  "help",
  "spawn-menu",
  "destinations",
  "crew",
  "timeline",
  "settings",
  "inbox",
] as const satisfies readonly RevealSurface[];

type UnlistedReveal = Exclude<RevealSurface, (typeof REVEAL_ORDER)[number]>;
/** A surface missing from `REVEAL_ORDER` fails HERE, at compile time. */
const _everyRevealIsOrdered: UnlistedReveal extends never ? true : never = true;
void _everyRevealIsOrdered;

/**
 * Record (or forget) a reveal so `Esc` pops in the order things opened.
 * Reading the CURRENT flag is what keeps the stack honest: a toggle that
 * closed something must not leave it behind.
 */
export function noteReveal(
  stack: readonly RevealSurface[],
  layer: RevealSurface,
  isOpen: boolean
): RevealSurface[] {
  const without = stack.filter((entry) => entry !== layer);
  return isOpen ? [...without, layer] : without;
}
