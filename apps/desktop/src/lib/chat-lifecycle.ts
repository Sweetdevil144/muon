import {
  cancelChatJobs,
  stopThenArchiveChat,
  summarizeChatCancel,
  type CancelChatJobsOptions,
  type CancelChatJobsResult,
  type StopThenArchiveClient,
} from "@muon/client";
import type { OrchestratorChatRecord } from "@muon/client";

/**
 * The chat's lifecycle acts, both routed through the SHARED governed stop in
 * @muon/client so the desktop, the CLI, and the TUI cancel a chat with exactly
 * the same per-job `interrupt` authority. Nothing here kills a job directly.
 */
export type ChatLifecycleClient = StopThenArchiveClient;

export type ArchiveChatResult = {
  chat: OrchestratorChatRecord;
  /** Every job id seen for the chat, for per-job UI teardown (terminals/panes). */
  jobIds: string[];
  /** What the stop actually achieved, for honest reporting. */
  cancel: CancelChatJobsResult;
};

export type CancelChatResult = CancelChatJobsResult & {
  /** One honest line for the operator ("Stopped 2 of 3 …"). */
  summary: string;
};

export type ChatLifecycleOptions = CancelChatJobsOptions & {
  /** Back-compat alias for `settleMs` (the old archive knob). */
  timeoutMs?: number;
};

function settleOptions(options: ChatLifecycleOptions): CancelChatJobsOptions {
  const { timeoutMs, ...rest } = options;
  return {
    ...rest,
    settleMs: rest.settleMs ?? timeoutMs,
  };
}

/**
 * Cancel every queued/running job this chat owns and LEAVE THE CHAT USABLE.
 * Idempotent (a second press re-checks and re-reports; already-fenced jobs are
 * not re-interrupted) and honest (a job still running is reported as still
 * running, never as cancelled).
 */
export async function cancelChat(
  client: ChatLifecycleClient,
  chatId: string,
  options: ChatLifecycleOptions = {}
): Promise<CancelChatResult> {
  const result = await cancelChatJobs(client, chatId, settleOptions(options));
  return { ...result, summary: summarizeChatCancel(result) };
}

/**
 * Stop every job owned by a chat, then archive it.
 *
 * Archiving is fail-closed at the backend: `DELETE /api/chats/:id` refuses
 * while the chat owns a queued/running dispatch. Interrupting a RUNNING job
 * only records the request — the runner terminalizes it once the vendor
 * actually drains — so this settles against the authoritative ledger and only
 * archives once the precondition is genuinely true. If something will not stop
 * we throw a ChatStopBlockedError naming the exact jobs (never a bare 409) and
 * the chat stays active and visible.
 */
export async function archiveChatAfterStopping(
  client: ChatLifecycleClient,
  chatId: string,
  options: ChatLifecycleOptions = {}
): Promise<ArchiveChatResult> {
  const result = await stopThenArchiveChat(
    client,
    chatId,
    settleOptions(options)
  );
  return {
    chat: result.chat,
    jobIds: result.observedJobIds,
    cancel: result.cancel,
  };
}
