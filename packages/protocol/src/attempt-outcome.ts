import { z } from "zod";

/** Substrate §3.4 — structured result of an `attempt` note. NULL on the row = legacy. */
export const ATTEMPT_OUTCOMES = [
  "worked",
  "abandoned",
  "superseded",
  "unknown",
] as const;

export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const attemptOutcomeSchema = z.enum(ATTEMPT_OUTCOMES);

/** Accept wire null/undefined; reject any other string. */
export const attemptOutcomeNullableSchema = attemptOutcomeSchema.nullish();

export function isAttemptOutcome(value: unknown): value is AttemptOutcome {
  return attemptOutcomeSchema.safeParse(value).success;
}

/**
 * Mission-scoped attempt recall (substrate §3.4): "has anyone tried X this
 * mission?" as one governed query. Callers still pass `chatId` / `workspacePath`
 * from authenticated job scope — this helper only fixes the shape.
 */
export function missionAttemptRecallFilter(args: {
  chatId: string;
  module?: string;
  modules?: string[];
  symbol?: string;
  symbols?: string[];
  outcome?: AttemptOutcome | readonly AttemptOutcome[];
  taskId?: string;
  laneId?: string;
}): {
  kind: "attempt";
  chatId: string;
  module?: string;
  modules?: string[];
  symbol?: string;
  symbols?: string[];
  outcome?: AttemptOutcome;
  taskId?: string;
  laneId?: string;
} {
  const outcomes = args.outcome
    ? Array.isArray(args.outcome)
      ? args.outcome
      : [args.outcome]
    : [];
  if (outcomes.length > 1) {
    throw new Error(
      "missionAttemptRecallFilter accepts one outcome; use the R5 filter grammar for `in`."
    );
  }
  return {
    kind: "attempt",
    chatId: args.chatId,
    ...(args.module ? { module: args.module } : {}),
    ...(args.modules?.length ? { modules: args.modules } : {}),
    ...(args.symbol ? { symbol: args.symbol } : {}),
    ...(args.symbols?.length ? { symbols: args.symbols } : {}),
    ...(outcomes[0] ? { outcome: outcomes[0] } : {}),
    ...(args.taskId ? { taskId: args.taskId } : {}),
    ...(args.laneId ? { laneId: args.laneId } : {}),
  };
}
