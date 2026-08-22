import type { MuonApiClient } from "@muon/client";
import type { ForkMissionResult } from "../shared/ipc.js";
import { requireRendererTask } from "./renderer-chat-scope.js";

/**
 * ADR-0044/0071 — the desktop half of one-gesture fork-from-step.
 *
 * Extracted from the `muon:forkMission` IPC handler for the same reason
 * `continue-on-lane.ts` exists: the interesting decisions (whether the
 * renderer may fork this job at all, whether the selection is still stable
 * when the fork is filed, which words a refusal reaches the operator in)
 * are testable without Electron. The handler is an adapter.
 *
 * TWO THINGS THIS MUST NOT DO, stated so a later edit has to argue with them:
 *
 *  1. It must not re-derive what makes a fork a fork. The latest-settled-step
 *     guard, gesture-time capture, authority re-derivation, offer-prefix
 *     inheritance and compensation are the fork route's
 *     (backend/src/routes/dispatch.ts); this names the step, the brief and
 *     the lane, nothing more — the same three fields the CLI and the TUI
 *     send through the ONE client method.
 *  2. It must not rephrase a refusal. The route's sentence names the exact
 *     defect ("…is not the task's latest settled step…") and the fix; a
 *     desk-local paraphrase is how a surface starts telling a different
 *     story from the CLI about the same machine.
 */
export type ForkMissionInput = {
  sourceJobId: string;
  brief: string;
  vendor: string;
  title?: string;
};

/** Narrowed on purpose: an edit reaching for anything wider must not typecheck. */
export type ForkMissionClient = Pick<
  MuonApiClient,
  "getDispatchJob" | "forkMission" | "getChat" | "listDispatchJobs"
>;

export async function forkMissionFromStep(
  client: ForkMissionClient,
  input: ForkMissionInput,
  /** The renderer's bound chat; null = no mission selected, a stated refusal. */
  chatId: string | null,
  /**
   * Throws when the renderer's selection moved while the fence reads were in
   * flight. Called AFTER the fence and BEFORE the write, so a fork authorized
   * against chat A can never be filed under a window now showing chat B. The
   * thrown sentence is the refusal the operator reads.
   */
  assertSelectionUnchanged: () => void
): Promise<ForkMissionResult> {
  if (!chatId) {
    return {
      ok: false,
      reason: "Select a mission before forking one of its steps.",
    };
  }
  const sourceJobId = String(input.sourceJobId ?? "").trim();
  const brief = String(input.brief ?? "").trim();
  if (!sourceJobId || !brief) {
    return {
      ok: false,
      reason: "A fork names its source step and carries a brief.",
    };
  }
  try {
    // The FENCE: the source job's task must belong to the renderer's own
    // bound chat, exactly as `continueOnLane` fences its task — a window can
    // never branch a mission it is not looking at.
    const sourceJob = await client.getDispatchJob(sourceJobId);
    await requireRendererTask(client, chatId, sourceJob.taskId);
    assertSelectionUnchanged();
    const forked = await client.forkMission({
      sourceJobId,
      brief,
      vendor: input.vendor,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    });
    return {
      ok: true,
      chatId: forked.chat.id,
      chatTitle: forked.chat.title,
      taskId: forked.task.id,
      jobId: forked.job.id,
      vendor: input.vendor,
    };
  } catch (error) {
    return {
      ok: false,
      // VERBATIM: the fork route's guards are the vocabulary.
      reason:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The fork was refused, and no reason was returned.",
    };
  }
}
