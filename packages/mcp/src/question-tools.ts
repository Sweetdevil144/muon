import {
  askBlockingQuestion,
  listOwnBlockingQuestions,
  withdrawBlockingQuestion,
} from "@muon/client";
import {
  MAX_QUESTION_BODY_CHARS,
  MAX_QUESTION_SUBJECT_CHARS,
} from "@muon/protocol";
import { fail, ok, type ToolDefinition } from "./agent-ui.js";
import type { ToolScope } from "./handlers.js";

/**
 * ADR-0090 — the question family's own dispatcher.
 *
 * Extracted from the base-tier monolith (handlers.ts) so the family's
 * invariants — the fold as the reader of record, the disclosed-set citation
 * binding, the withdrawal union — are locally reviewable, and so ADR-0082's
 * crew-context growth lands HERE rather than as new switch arms. The
 * extraction is BEHAVIOR-FROZEN: tool names, schemas, tier placement,
 * refusal strings, and every pinned behavior are bit-identical to the
 * monolith's; the inventory/probe pins are the review bar.
 *
 * The scope helpers arrive as DEPS (one spelling each, owned by the
 * composing surface) rather than re-derived here — the same reason the
 * withdrawal wire has exactly one decoder.
 */
export type QuestionToolDeps = {
  scope: ToolScope;
  coordinationScope: (
    scope: ToolScope,
    tool: string
  ) =>
    | { ok: true; apiBase: string; apiToken: string }
    | { ok: false; error: string };
  coordinate: (value: unknown) => string | undefined;
  coordinateArray: (
    value: unknown,
    maxItems: number
  ) => { valid: true; value?: string[] } | { valid: false };
};

export function createQuestionToolDefinitions(
  deps: QuestionToolDeps
): ToolDefinition[] {
  const { scope, coordinationScope, coordinate, coordinateArray } = deps;
  return [
    // ADR-0043 — the typed escalation to a HUMAN, for when the crew cannot
    // answer. Ask your peers first (peer_message); this files to the operator
    // inbox. Powerless by construction: no authority, no clock, no budget.
    {
      name: "question_ask",
      description:
        "File a BLOCKING QUESTION to the human operator's inbox — use it when you are genuinely blocked on something only a human can decide, and your crew (peer_message) could not answer. It confers no authority, pauses nothing, and extends no budget: decide yourself whether to keep working on something else, wait on a peer, or end your turn with a handoff naming the open question. Your identity and task are derived from your session; you cannot set a deadline or priority. Poll question_status for the answer.",
      inputSchema: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUESTION_SUBJECT_CHARS,
            description: "One line naming the decision you need.",
          },
          body: {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUESTION_BODY_CHARS,
            description:
              "The question itself: what you need decided, the options you see, and what blocks without it. Coordinates over content — point at paths, do not paste files.",
          },
        },
        required: ["subject", "body"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const transport = coordinationScope(scope, "question_ask");
        if (!transport.ok) {
          return fail(transport.error);
        }
        const question = await askBlockingQuestion({
          apiBase: transport.apiBase,
          apiToken: transport.apiToken,
          question: {
            subject: String(args.subject ?? ""),
            body: String(args.body ?? ""),
          },
        });
        return ok(
          {
            filed: question
              ? {
                  questionId: question.id,
                  subject: question.subject,
                  status: question.status,
                  askedAt: question.askedAt,
                }
              : null,
            // ADR-0069: the brain answered first, when confirmed canon
            // matched. Context, never authority — the citations are
            // HUMAN-CONFIRMED notes your own recall could reach; if they
            // settle the question, proceed and say so in your report. The
            // question stays on the human's inbox either way.
            ...(question?.memoryPreAnswer
              ? {
                  memoryPreAnswer: {
                    notes: question.memoryPreAnswer.notes,
                    note: "HUMAN-CONFIRMED memory that matches your question. If it settles the matter, proceed on it and cite the note ids in your report; the human still sees both the question and this pre-answer.",
                  },
                }
              : {}),
            // ADR-0082: the crew's working knowledge, labeled as what it
            // is. Context only — it can NEVER close a question, and
            // answered_from_memory may cite only the CONFIRMED pre-answer.
            ...(question?.crewContext
              ? {
                  crewContext: {
                    items: question.crewContext.items,
                    note: "Your CREW's working knowledge — unconfirmed same-mission notes and packets matching your question, each labeled with its own standing. Context only: nobody has vouched for these, they cannot close this question, and answered_from_memory citations must come from the confirmed pre-answer alone.",
                  },
                }
              : {}),
            note: "Filed to the human inbox as DATA. Nothing is paused and no budget is extended — keep working, or end your turn with a handoff naming this question.",
          },
          {
            evidence: {
              bounded: true,
              limit: 1,
              included: question ? 1 : 0,
              omitted: 0,
              kind: "server-derived blocking question",
            },
            coordination: {
              missionScoped: true,
              state: "question_filed",
            },
            nextActions: [
              "Continue useful work; a human answers on a MUON surface.",
              "Poll question_status when you next need the answer.",
            ],
          }
        );
      },
    },
    {
      name: "question_status",
      description:
        "Your own blocking questions and their answers. An answer is OPERATOR-AUTHORED — a human decision delivered as data on your pull, with its provenance. Questions from other jobs are never returned.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        const transport = coordinationScope(scope, "question_status");
        if (!transport.ok) {
          return fail(transport.error);
        }
        const questions = await listOwnBlockingQuestions({
          apiBase: transport.apiBase,
          apiToken: transport.apiToken,
        });
        const open = questions.filter((q) => q.status === "open").length;
        // ENFORCED bound, newest kept (answers are what the caller came
        // for): the attestation below states what was actually applied,
        // never a limit nothing implements (review pass 7 #4).
        const shown = questions.slice(-64);
        return ok(
          {
            questions: shown.map((q) => ({
              questionId: q.id,
              subject: q.subject,
              status: q.status,
              askedAt: q.askedAt,
              // ADR-0069: the disclosed pre-answer rides the durable read
              // too (review finding: a resumed session holding only a
              // question id could not perform the typed withdrawal because
              // this was the one path that hid the citations it requires).
              ...(q.memoryPreAnswer
                ? { memoryPreAnswer: q.memoryPreAnswer }
                : {}),
              ...(q.crewContext ? { crewContext: q.crewContext } : {}),
              ...(q.answer
                ? {
                    answer: q.answer,
                    answeredAt: q.answeredAt,
                    // Verified by the derivation fold from the audit-stamped
                    // actor on the answered row — not asserted here.
                    answeredBy: q.answeredBy ?? "operator",
                  }
                : {}),
            })),
          },
          {
            evidence: {
              bounded: true,
              limit: 64,
              included: shown.length,
              omitted: questions.length - shown.length,
              kind: "own blocking questions (answers operator-authored)",
            },
            coordination: {
              missionScoped: true,
              state: open > 0 ? "awaiting_human" : "clear",
            },
            nextActions:
              open > 0
                ? [
                    "A human answers on a MUON surface; do not block your whole turn polling.",
                  ]
                : [],
          }
        );
      },
    },
    {
      name: "question_withdraw",
      description:
        "Withdraw ONE of your OWN open blocking questions. If the memory pre-answer question_ask disclosed settled the matter, say so: reason 'answered_from_memory' with cited_note_ids drawn FROM that pre-answer — recorded as a typed, cited terminal state the human can still review, never a human close and never an approval. Omit the reason for a plain withdrawal. Self-scoped: another job's question is not withdrawable from here.",
      inputSchema: {
        type: "object",
        properties: {
          question_id: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Your own question's id (from question_ask / question_status).",
          },
          reason: {
            type: "string",
            enum: ["answered_from_memory"],
            description:
              "Only when the DISCLOSED pre-answer settled the question. Requires cited_note_ids.",
          },
          cited_note_ids: {
            type: "array",
            items: { type: "string", maxLength: 128 },
            maxItems: 3,
            description:
              "The pre-answer note ids that settled it. The server refuses ids the pre-answer never disclosed.",
          },
        },
        required: ["question_id"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const transport = coordinationScope(scope, "question_withdraw");
        if (!transport.ok) {
          return fail(transport.error);
        }
        const questionId = coordinate(args.question_id);
        if (!questionId) {
          return fail("question_id must be a single-line coordinate");
        }
        const reason =
          args.reason === "answered_from_memory" ? args.reason : undefined;
        if (args.reason !== undefined && !reason) {
          return fail("reason must be 'answered_from_memory' when present");
        }
        const cited = coordinateArray(args.cited_note_ids, 3);
        if (!cited.valid) {
          return fail(
            "cited_note_ids must contain at most 3 single-line note ids"
          );
        }
        if (reason && (cited.value ?? []).length === 0) {
          return fail(
            "answered_from_memory requires the cited_note_ids that settled it (from the question's own pre-answer)"
          );
        }
        // Citations WITHOUT the reason are refused, not silently dropped
        // (review finding): the caller stated provenance intent; losing it
        // quietly is worse than making them say what they mean.
        if (!reason && (cited.value ?? []).length > 0) {
          return fail(
            "cited_note_ids requires reason 'answered_from_memory' — either state that the pre-answer settled it, or withdraw plainly without citations"
          );
        }
        const withdrawn = await withdrawBlockingQuestion({
          apiBase: transport.apiBase,
          apiToken: transport.apiToken,
          questionId,
          // ONE adaptation into the protocol boundary; a plain withdrawal
          // is the ABSENCE of the typed payload, not an empty object.
          ...(reason
            ? { withdrawal: { reason, citedNoteIds: cited.value ?? [] } }
            : {}),
        });
        return ok(
          {
            withdrawn,
            ...(reason ? { reason, citedNoteIds: cited.value ?? [] } : {}),
            note: reason
              ? "Recorded as answered_from_memory with its citations — a typed terminal state the human can still review. Nothing was approved and no human answered."
              : "Withdrawn. The human's inbox no longer holds it.",
          },
          {
            coordination: {
              missionScoped: true,
              state: "question_withdrawn",
            },
            nextActions: [
              reason
                ? "Proceed on the cited canon; cite the note ids in your report."
                : "Continue your work; re-ask with question_ask if it becomes blocking again.",
            ],
          }
        );
      },
    },
  ];
}
