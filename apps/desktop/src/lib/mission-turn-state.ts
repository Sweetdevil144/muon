import type { DispatchJobRecord } from "@muon/client";

export type MissionTurnState = {
  activeRoot: DispatchJobRecord | null;
  latestRoot: DispatchJobRecord | null;
  running: boolean;
  recovered: boolean;
};

/**
 * Reconstruct Mission Chat ownership from durable dispatch rows. Renderer-local
 * promises are only an optimization; after a Desktop restart the queued/running
 * root remains the authority that locks the composer and exposes cancellation.
 */
export function deriveMissionTurnState(
  jobs: DispatchJobRecord[],
  localRunning: boolean
): MissionTurnState {
  const roots = jobs
    .filter((job) => job.parentJobId === null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const activeRoot =
    roots.find((job) => job.status === "queued" || job.status === "running") ??
    null;
  return {
    activeRoot,
    latestRoot: roots[0] ?? null,
    running: localRunning || activeRoot !== null,
    recovered: !localRunning && activeRoot !== null,
  };
}

/**
 * WHICH ROOT EACH OPEN LIVE MIRROR BELONGS TO — the transcript's turn boundary.
 *
 * A logical turn is what the HUMAN started, and that is not always one root.
 * When the coordinator answers without proving its governed crew contract,
 * `packages/orchestrator/src/chat.ts` admits ONE bounded CORRECTION root inside
 * the same turn. That root carries no human message and no continuation, so the
 * brain stamps no `runId`-bearing row for it anywhere: only a human turn's
 * trusted `[you]` row and a continuation wake get one, and the orchestrator's
 * own "Root … was admitted" milestone carries none either.
 *
 * The instant it is admitted, {@link deriveMissionTurnState} moves `activeRoot`
 * onto it while the optimistic live mirror is still rendering the ORIGINATING
 * root's exchange. Handing that newer root to `settledHistoryChunks` as the
 * boundary finds no row to cut at, so the originating turn's persisted rows are
 * absorbed into history WHILE the mirror still holds them — and the mirror is
 * deliberately not de-duplicated while a turn runs. The human's message and the
 * coordinator's whole reply then print twice, for as long as the turn lasts.
 *
 * So the boundary is PINNED: the first root observed while a chat's mirror is
 * open stays that mirror's root until the mirror closes. `send()` reopens the
 * mirror and drops the pin, and the composer is locked for as long as a root is
 * active — so a turn this window starts always re-pins from "no root yet",
 * never from its predecessor's.
 *
 * Pure and total. Chats whose mirror is closed are dropped rather than carried,
 * which both releases the pin and keeps the map bounded by the mirrors that
 * actually exist. A chat with an open mirror and no root yet pins `null`, which
 * the caller reads as "boundary unknown" and fails closed on.
 */
export function pinLiveTurnRoots(
  pinned: Readonly<Record<string, string | null>>,
  liveMirrorChatIds: readonly string[],
  jobs: readonly DispatchJobRecord[]
): Record<string, string | null> {
  const next: Record<string, string | null> = {};
  for (const chatId of liveMirrorChatIds) {
    const existing = pinned[chatId] ?? null;
    if (existing) {
      next[chatId] = existing;
      continue;
    }
    // Same rule the composer and the stop control are derived from, scoped the
    // way `scopeDesktopStateToChat` scopes jobs — one definition of "the root
    // this chat is running", never a second one that could disagree with it.
    next[chatId] =
      deriveMissionTurnState(
        jobs.filter((job) => job.chatId === chatId),
        false
      ).activeRoot?.id ?? null;
  }
  return next;
}
