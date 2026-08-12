import { useEffect, useState } from "react";
import type {
  DispatchJobRecord,
  OrchestratorChatRecord,
} from "@muon/client";
import type { WorkspaceReview } from "../../shared/ipc.js";

export type WorkspaceReviewTarget = {
  chatId: string;
  jobId: string;
  status: string;
};

export type WorkspaceReviewEntry = {
  jobId: string;
  loading: boolean;
  review: WorkspaceReview | null;
};

export type WorkspaceReviewsByChat = Record<string, WorkspaceReviewEntry>;

/**
 * Select the same job shape the A2 dock already reviews: the chat's active task
 * prefers its orchestrator/root job, then any job on that task. One target per
 * chat means the dock and Workspaces sidebar consume one shared IPC result.
 */
export function selectWorkspaceReviewTargets(
  chats: OrchestratorChatRecord[],
  jobs: DispatchJobRecord[]
): WorkspaceReviewTarget[] {
  const targets: WorkspaceReviewTarget[] = [];
  for (const chat of chats) {
    const chatJobs = jobs.filter((job) => job.chatId === chat.id);
    const activeTaskId = chat.taskId ?? chatJobs[0]?.taskId ?? null;
    if (!activeTaskId) {
      continue;
    }
    const reviewJob =
      chatJobs.find(
        (job) =>
          job.taskId === activeTaskId &&
          job.capabilityMode === "orchestrator"
      ) ?? chatJobs.find((job) => job.taskId === activeTaskId);
    if (!reviewJob) {
      continue;
    }
    targets.push({
      chatId: chat.id,
      jobId: reviewJob.id,
      status: reviewJob.status,
    });
  }
  return targets;
}

export function useWorkspaceReviews(
  chats: OrchestratorChatRecord[],
  jobs: DispatchJobRecord[]
): WorkspaceReviewsByChat {
  const targets = selectWorkspaceReviewTargets(chats, jobs);
  const targetKey = targets
    .map((target) => `${target.chatId}:${target.jobId}:${target.status}`)
    .join("|");
  const [entries, setEntries] = useState<WorkspaceReviewsByChat>({});

  useEffect(() => {
    let stopped = false;
    const initial = Object.fromEntries(
      targets.map((target) => [
        target.chatId,
        { jobId: target.jobId, loading: true, review: null },
      ])
    ) as WorkspaceReviewsByChat;
    setEntries(initial);

    if (typeof window.muon.workspaceReview !== "function") {
      setEntries(
        Object.fromEntries(
          targets.map((target) => [
            target.chatId,
            { jobId: target.jobId, loading: false, review: null },
          ])
        ) as WorkspaceReviewsByChat
      );
      return;
    }

    for (const target of targets) {
      void window.muon
        .workspaceReview({ jobId: target.jobId, chatId: target.chatId })
        .then((review) => {
          if (stopped) {
            return;
          }
          setEntries((current) => {
            if (current[target.chatId]?.jobId !== target.jobId) {
              return current;
            }
            return {
              ...current,
              [target.chatId]: {
                jobId: target.jobId,
                loading: false,
                review,
              },
            };
          });
        })
        .catch(() => {
          if (stopped) {
            return;
          }
          setEntries((current) => {
            if (current[target.chatId]?.jobId !== target.jobId) {
              return current;
            }
            return {
              ...current,
              [target.chatId]: {
                jobId: target.jobId,
                loading: false,
                review: null,
              },
            };
          });
        });
    }

    return () => {
      stopped = true;
    };
    // `targetKey` includes every target identity + status. The store may poll a
    // fresh object every two seconds, but a review refetch happens only when the
    // actual reviewed job set changes or a job crosses a status boundary.
  }, [targetKey]);

  return entries;
}
