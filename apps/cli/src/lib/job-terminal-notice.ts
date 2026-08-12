import type { DispatchJobRecord } from "@muon/client";

// A delegated worker job bound to a chat: chatId is inherited from the chat
// root and parentJobId is set on delegation, while the chat's own session turn
// is a root (chatId, no parentJobId). Mirrors the desktop monitor's predicate.
function isWatchedWorkerJob(job: DispatchJobRecord): boolean {
  return Boolean(job.chatId) && Boolean(job.parentJobId);
}

const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);

/**
 * Manual durable-orchestration mirror for the CLI (FD-3: the CLI mirror is
 * manual). Given the latest jobs and the ids already announced, return notice
 * lines for delegated workers that have newly reached terminal, and record them
 * in `seen`. The CLI never auto-continues and never writes the dedupe milestone
 * — it just tells the human a worker landed so they can send a message to
 * reconcile, so a desktop surface's bounded auto-continue is never suppressed.
 *
 * Prime `seen` once at session start (call and discard the result) so workers
 * that finished before the session opened are not re-announced.
 */
export function collectTerminalNotices(
  jobs: DispatchJobRecord[],
  seen: Set<string>
): string[] {
  const lines: string[] = [];
  for (const job of jobs) {
    if (!isWatchedWorkerJob(job)) {
      continue;
    }
    if (!TERMINAL_STATUSES.has(job.status)) {
      continue;
    }
    if (seen.has(job.id)) {
      continue;
    }
    seen.add(job.id);
    lines.push(
      `⑂ worker ${job.vendor} job ${job.id} finished (${job.status}) — send a message to reconcile`
    );
  }
  return lines;
}
