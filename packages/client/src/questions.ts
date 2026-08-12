import { z } from "zod";
import {
  blockingQuestionAnswerSchema,
  blockingQuestionAskSchema,
  blockingQuestionSchema,
  type BlockingQuestion,
  type BlockingQuestionAsk,
} from "@muon/protocol";

// ADR-0043 — the client half of blocking questions. Same posture as the A2A
// client: the agent tier never names its own identity (job/task derived from
// the exact-job bearer server-side); the operator tier names the task because
// a human holding the operator token is asking. The QUESTION body is untrusted
// agent text on every operator surface; the ANSWER is operator-authored and is
// delivered to the agent as data with that provenance.

type QuestionsRequest = {
  apiBase: string;
  apiToken?: string;
  fetcher?: typeof fetch;
};

async function questionsJson<T extends z.ZodTypeAny>(
  input: QuestionsRequest,
  path: string,
  schema: T,
  post?: unknown
): Promise<z.infer<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.apiToken) headers.authorization = `Bearer ${input.apiToken}`;
  if (post !== undefined) headers["content-type"] = "application/json";
  const response = await (input.fetcher ?? fetch)(
    `${input.apiBase.replace(/\/$/, "")}${path}`,
    post === undefined
      ? { headers }
      : { method: "POST", headers, body: JSON.stringify(post) }
  );
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).trim();
    let reason = text.slice(0, 500);
    try {
      const body = JSON.parse(text) as { message?: unknown };
      if (typeof body.message === "string" && body.message) {
        reason = body.message.slice(0, 500);
      }
    } catch {
      // non-JSON error body
    }
    throw new Error(
      `Questions request failed (${response.status})${reason ? `: ${reason}` : ""}`
    );
  }
  return schema.parse(await response.json());
}

/** Agent tier: file one question. Validated locally first (strict schema —
 *  identity and lever fields are rejected, not ignored). */
export async function askBlockingQuestion(
  input: QuestionsRequest & { question: BlockingQuestionAsk }
): Promise<BlockingQuestion | null> {
  const body = blockingQuestionAskSchema.parse(input.question);
  const result = await questionsJson(
    input,
    "/api/questions",
    z.object({ question: blockingQuestionSchema.nullable() }),
    body
  );
  return result.question;
}

/** Agent tier: the pull path — own questions, answers included as data. */
export async function listOwnBlockingQuestions(
  input: QuestionsRequest
): Promise<BlockingQuestion[]> {
  const result = await questionsJson(
    input,
    "/api/questions",
    z.object({ questions: z.array(blockingQuestionSchema) })
  );
  return result.questions;
}

/** Agent tier: withdraw one of YOUR OWN open questions. */
export async function withdrawBlockingQuestion(
  input: QuestionsRequest & { questionId: string }
): Promise<string> {
  const result = await questionsJson(
    input,
    `/api/questions/${encodeURIComponent(input.questionId)}/withdraw`,
    z.object({ withdrawn: z.string() }),
    {}
  );
  return result.withdrawn;
}

/** Operator tier: every OPEN question on the machine, for the inbox. */
export async function listOpenBlockingQuestions(
  input: QuestionsRequest
): Promise<{ questions: BlockingQuestion[]; truncated: boolean }> {
  return questionsJson(
    input,
    "/api/questions/open",
    z.object({
      questions: z.array(blockingQuestionSchema),
      truncated: z.boolean().default(false),
    })
  );
}

/** Operator tier: one task's questions, for the inbox. */
export async function listTaskBlockingQuestions(
  input: QuestionsRequest & { taskId: string }
): Promise<BlockingQuestion[]> {
  const result = await questionsJson(
    input,
    `/api/questions/task/${encodeURIComponent(input.taskId)}`,
    z.object({ questions: z.array(blockingQuestionSchema) })
  );
  return result.questions;
}

/** Operator tier: answer one open question. Never re-answers (409 upstream). */
export async function answerBlockingQuestion(
  input: QuestionsRequest & {
    questionId: string;
    taskId: string;
    answer: string;
  }
): Promise<BlockingQuestion | null> {
  const body = {
    ...blockingQuestionAnswerSchema.parse({ answer: input.answer }),
    taskId: input.taskId,
  };
  const result = await questionsJson(
    input,
    `/api/questions/${encodeURIComponent(input.questionId)}/answer`,
    z.object({ question: blockingQuestionSchema.nullable() }),
    body
  );
  return result.question;
}
