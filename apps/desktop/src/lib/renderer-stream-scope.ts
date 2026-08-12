import type { MuonApiClient, StreamChunk } from "@muon/client";
import type {
  JobTerminalQuery,
  JobTerminalResponse,
  StreamsQuery,
} from "../shared/ipc.js";
import { requireRendererDispatchJob } from "./renderer-chat-scope.js";

type RendererStreamClient = Pick<
  MuonApiClient,
  "getChat" | "getDispatchJob" | "listStreamChunks"
>;

type RendererJobTerminalClient = Pick<
  MuonApiClient,
  "getChat" | "getDispatchJob" | "readJobTerminal"
>;

/**
 * Renderer stream reads are coordinates-only and chat-bound. A renderer may
 * read the selected chat's durable history or one exact dispatch owned by that
 * chat; broad agent/session filters never cross the trusted-main boundary.
 *
 * Out-of-scope coordinates return an empty page rather than exposing whether a
 * foreign job/chat exists.
 */
export async function listRendererStreamChunks(
  client: RendererStreamClient,
  chatId: string | null,
  query: StreamsQuery
): Promise<StreamChunk[]> {
  if (!chatId) {
    return [];
  }
  const cursor = {
    ...(query.afterSeq !== undefined ? { afterSeq: query.afterSeq } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.latest !== undefined ? { latest: query.latest } : {}),
  };

  if (query.runId) {
    const job = await requireRendererDispatchJob(
      client,
      chatId,
      query.runId
    ).catch(() => null);
    if (!job) {
      return [];
    }
    return client.listStreamChunks({ runId: query.runId, ...cursor });
  }

  if (query.taskId === chatId) {
    return client.listStreamChunks({ taskId: chatId, ...cursor });
  }

  return [];
}

/**
 * LIVE TERMINAL — the chat-bound, OPERATOR-tier read of one job's real console
 * (0038). Same scope rule as the stream read above: a renderer may watch a job
 * owned by the chat it names, and nothing else.
 *
 * ALWAYS RESOLVES. A foreign/unknown job, an archived chat, a brain that
 * predates the route, or a transport failure all come back as `unavailable`
 * with a sentence the tab can render — which makes it fall back to the RECORDED
 * stream, labelled, rather than showing a blank pane titled "Live".
 * `retryable` distinguishes "ask again next tick" (a 5xx/timeout/refused
 * socket) from "this answer will not change" (no such route, no such job), so
 * a poller cannot spin forever against a brain that will never answer.
 */
export async function readRendererJobTerminal(
  client: RendererJobTerminalClient,
  chatId: string | null,
  query: JobTerminalQuery
): Promise<JobTerminalResponse> {
  const scopedChatId = query.chatId ?? chatId;
  if (!scopedChatId) {
    return {
      status: "unavailable",
      reason: "Select a chat before watching a job's console.",
      retryable: false,
    };
  }
  const job = await requireRendererDispatchJob(
    client,
    scopedChatId,
    query.jobId
  ).catch(() => null);
  if (!job) {
    // Deliberately does not distinguish "no such job" from "another chat's
    // job" — the same posture as the stream read.
    return {
      status: "unavailable",
      reason: "That dispatch is not part of this chat, so its console cannot be read here.",
      retryable: false,
    };
  }
  try {
    const view = await client.readJobTerminal(query.jobId, {
      ...(query.afterSeq !== undefined ? { afterSeq: query.afterSeq } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    return { status: "ok", ...view };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "the read failed";
    // A brain without the route (404) will never grow one mid-session; a
    // refused/5xx/timed-out one might recover on the next tick.
    const permanent = /\b(404|not found|501|not implemented)\b/i.test(message);
    return {
      status: "unavailable",
      reason: `MUON could not read this job's live console: ${message}`,
      retryable: !permanent,
    };
  }
}
