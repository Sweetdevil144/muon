import type {
  GovernedScheduleRecord,
  MuonApiClient,
  ScheduleOccurrenceRecord,
} from "@muon/client";

type ScheduleClient = Pick<
  MuonApiClient,
  "claimDueSchedule" | "updateScheduleOccurrence"
>;

export type GovernedScheduleClaim = {
  schedule: GovernedScheduleRecord;
  occurrence: ScheduleOccurrenceRecord;
};

export type GovernedScheduleExecutor = {
  start(intervalMs?: number): void;
  stop(): void;
  poll(): Promise<void>;
  running(): boolean;
};

/**
 * Trusted-main schedule driver. It never interprets objectives and never owns
 * authority: `canClaim` must prove the live standing-consent posture before the
 * body-less claim, while the backend atomically selects the exact due record.
 */
export function createGovernedScheduleExecutor(input: {
  client: () => ScheduleClient;
  canClaim: () => Promise<boolean>;
  execute: (claim: GovernedScheduleClaim) => Promise<{
    chatId: string;
    rootJobId?: string;
    error?: string;
  }>;
  log?: (line: string) => void;
}): GovernedScheduleExecutor {
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let stopped = true;

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      if (!(await input.canClaim())) return;
      const claim = await input.client().claimDueSchedule();
      if (!claim) return;
      let chatId: string | undefined;
      try {
        const result = await input.execute(claim);
        chatId = result.chatId;
        await input.client().updateScheduleOccurrence({
          scheduleId: claim.schedule.id,
          occurrenceId: claim.occurrence.id,
          status: result.error ? "failed" : "done",
          chatId: result.chatId,
          ...(result.rootJobId ? { rootJobId: result.rootJobId } : {}),
          ...(result.error ? { error: result.error.slice(0, 4_000) } : {}),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "scheduled turn failed";
        await input
          .client()
          .updateScheduleOccurrence({
            scheduleId: claim.schedule.id,
            occurrenceId: claim.occurrence.id,
            status: "failed",
            ...(chatId ? { chatId } : {}),
            error: message.slice(0, 4_000),
          })
          .catch((writeError) =>
            input.log?.(
              `[schedule] terminal write failed for '${claim.occurrence.id}': ${
                writeError instanceof Error ? writeError.message : String(writeError)
              }`
            )
          );
        input.log?.(`[schedule] '${claim.schedule.id}' failed: ${message}`);
      }
    } catch (error) {
      input.log?.(
        `[schedule] poll failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      polling = false;
    }
  };

  return {
    poll,
    running: () => timer !== null,
    start: (intervalMs = 15_000) => {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => void poll(), Math.max(1_000, intervalMs));
      void poll();
    },
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
