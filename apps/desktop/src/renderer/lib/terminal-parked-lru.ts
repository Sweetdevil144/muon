/**
 * ROADMAP T4 — the PARKED-RUNTIME LRU's POLICY: which mounted human terminal
 * panes should have their RENDERER (XTerm) resources released right now.
 *
 * Pure and DOM-free so the eviction math is unit-testable without React or a
 * real terminal — `app.tsx` is the only caller, feeding it the chat's
 * mounted terminal ids and an MRU order it maintains as a ref.
 *
 * The pty host session and byte channel are NEVER touched by this policy —
 * only which panes may currently hold a live XTerm instance. A pane outside
 * the cap is "parked": `terminal-tab.tsx` disposes its view (capturing a
 * serialize-addon snapshot first) while its port stays open and its host
 * session keeps running, unattended, exactly like an ordinary hidden pane's
 * pty already does.
 */

/** How many terminal panes may hold a live XTerm instance at once, across
 *  every chat. Small: a founder with a dozen vendor tabs open across chats
 *  should not carry a dozen live XTerm/canvas instances just because they
 *  were opened once — but the handful actually being switched between stay
 *  warm (no re-mount flash) the way they did before T4. */
export const DEFAULT_PARKED_LRU_CAPACITY = 6;

/**
 * Move `id` to the front of `order` (most-recently-used), preserving the
 * relative order of everything else. A no-op shape-wise for an `id` already
 * at the front.
 */
export function touchTerminalMruOrder(
  order: readonly string[],
  id: string
): string[] {
  return [id, ...order.filter((existing) => existing !== id)];
}

/**
 * Reconcile the MRU order against what is actually mounted right now: drops
 * any id that closed, and appends any newly-mounted id (created but not yet
 * "touched" as active) to the LEAST-recently-used end — a pane opened in the
 * background is not, by that fact alone, one a human is looking at.
 */
export function reconcileTerminalMruOrder(
  order: readonly string[],
  mountedIds: readonly string[]
): string[] {
  const mounted = new Set(mountedIds);
  const kept = order.filter((id) => mounted.has(id));
  const known = new Set(kept);
  const appended = mountedIds.filter((id) => !known.has(id));
  return [...kept, ...appended];
}

/**
 * The set of mounted ids that should be PARKED right now: every id beyond
 * `capacity` in MRU order. `activeId`, if given, is always exempted — a pane
 * currently on screen can never be released regardless of its position (it
 * is retouched separately, but this is the fail-safe: parking what a human
 * is looking at would be visibly broken).
 */
export function computeParkedTerminalIds(
  order: readonly string[],
  activeId: string | null,
  capacity: number = DEFAULT_PARKED_LRU_CAPACITY
): ReadonlySet<string> {
  const parked = new Set<string>();
  if (capacity < 0) {
    return parked;
  }
  order.slice(capacity).forEach((id) => {
    if (id !== activeId) {
      parked.add(id);
    }
  });
  return parked;
}
