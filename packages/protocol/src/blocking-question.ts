import { z } from "zod";
import { agentRoleSchema } from "./agent-role.js";
import { isDangerousCodePoint } from "./evasion-corpus.js";
import {
  MAX_PEER_BODY_CHARS,
  MAX_PEER_SUBJECT_CHARS,
} from "./a2a.js";

/**
 * ADR-0043 — a blocking question is a typed fact, not prose an agent must
 * remember to emit.
 *
 * The contract, compressed from the ADR:
 *  - D1: questions live on the EVENT SPINE (open / answered / withdrawn),
 *    derived on read — no table, no migration. `deriveBlockingQuestions`
 *    below IS that derivation, kept here so both sides fold the same way.
 *  - D2: the question body is UNTRUSTED agent text (same class as a peer
 *    message: rendered, quotable, never executed, never confirmed memory);
 *    the answer is operator-authored and delivered to the agent as data.
 *  - D3: it surfaces in the inbox but is ANSWER-shaped: no approve/reject,
 *    no receipt, and answering confers no authority. The ask schema is
 *    strict and identity-free, so a question cannot smuggle a grant request.
 *  - D4: asking is worker-tier against the caller's own authenticated
 *    coordinate; answering is operator-tier only.
 *  - D5: filing a question stops no clock and extends no budget — there is
 *    deliberately NO deadline or priority field an agent could use as a
 *    lever. What the agent may express is the question, nothing about how
 *    the world must reshape around it.
 *
 * Stated limitation (ships with every surface of this feature): MUON does not
 * own the vendor runtime and cannot intercept the vendor's own interactive
 * ask. This types the questions an agent CHOOSES to file through MUON.
 */

// The event-kind names both sides must agree on (backend files them, surfaces
// derive from them; a restated literal is a literal that drifts).
export const QUESTION_BLOCKED_EVENT_KIND = "question.blocked";
export const QUESTION_ANSWERED_EVENT_KIND = "question.answered";
export const QUESTION_WITHDRAWN_EVENT_KIND = "question.withdrawn";
/** ADR-0069: MUON's own recall answer, filed by the SERVER beside the ask.
 *  Context for both sides — never a close, never authority. */
export const QUESTION_PREANSWER_EVENT_KIND = "question.memory_preanswer";
/** ADR-0082: the CREW's working knowledge beside the ask — same-mission
 *  unconfirmed notes (findings included) and packets that match the
 *  question. Labeled context, never canon: it can never close a question. */
export const QUESTION_CREW_CONTEXT_EVENT_KIND = "question.crew_context";

export const MAX_PREANSWER_NOTES = 3;
export const MAX_PREANSWER_EXCERPT_CHARS = 240;

/** One HUMAN-CONFIRMED note the brain offered as a pre-answer: coordinate +
 *  bounded excerpt. The excerpt is confirmed canon (already crew-readable
 *  under the asker's own fence — the recall that found it was the asker's). */
export const questionPreAnswerNoteSchema = z
  .object({
    noteId: z.string().min(1).max(128),
    kind: z.string().min(1).max(32),
    excerpt: z.string().min(1).max(MAX_PREANSWER_EXCERPT_CHARS),
  })
  .strict();
export type QuestionPreAnswerNote = z.infer<typeof questionPreAnswerNoteSchema>;

export const questionMemoryPreAnswerSchema = z
  .object({
    notes: z.array(questionPreAnswerNoteSchema).min(1).max(MAX_PREANSWER_NOTES),
    disclosedAt: z.string().min(1),
  })
  .strict();
export type QuestionMemoryPreAnswer = z.infer<
  typeof questionMemoryPreAnswerSchema
>;

/** ADR-0082: one crew-context item — a coordinate + bounded excerpt + its
 *  OWN standing, stated ("unconfirmed note by agent:job:x",
 *  "typed_degraded packet"). The label is the contract: what your crew
 *  currently believes, not what the brain vouches for. */
export const questionCrewContextItemSchema = z
  .object({
    kind: z.enum(["note", "packet"]),
    id: z.string().min(1).max(128),
    standing: z.string().min(1).max(120),
    excerpt: z.string().min(1).max(MAX_PREANSWER_EXCERPT_CHARS),
  })
  .strict();
export type QuestionCrewContextItem = z.infer<
  typeof questionCrewContextItemSchema
>;

export const questionCrewContextSchema = z
  .object({
    items: z
      .array(questionCrewContextItemSchema)
      .min(1)
      .max(MAX_PREANSWER_NOTES),
    disclosedAt: z.string().min(1),
  })
  .strict();
export type QuestionCrewContext = z.infer<typeof questionCrewContextSchema>;

/** ADR-0069 D2: the one typed withdraw reason. A withdrawal that proceeds on
 *  the brain's cited answer RECORDS that, with the citations — distinct from
 *  a plain withdrawal and never impersonating a human close. */
export const QUESTION_WITHDRAW_REASON_ANSWERED_FROM_MEMORY =
  "answered_from_memory" as const;

/** The TYPED withdrawal payload: the reason WITH the citations that settled
 *  it — the only shape a caller may STATE. A plain withdrawal is the
 *  ABSENCE of this payload (review finding: inferring a type from a union
 *  containing `{}` produced a branch TypeScript accepts for any non-null
 *  object, un-enforcing the very invariant this boundary centralizes). */
export const blockingQuestionWithdrawalSchema = z
  .object({
    reason: z.literal(QUESTION_WITHDRAW_REASON_ANSWERED_FROM_MEMORY),
    citedNoteIds: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(MAX_PREANSWER_NOTES),
  })
  .strict();
export type BlockingQuestionWithdrawal = z.infer<
  typeof blockingQuestionWithdrawalSchema
>;

/** THE wire boundary (review finding: the reason⇄citations invariant
 *  existed as three drifting conditional implementations — route, client,
 *  MCP). `{}` is accepted AT THE WIRE ONLY (a plain withdrawal's HTTP
 *  body); it is deliberately not part of any exported TypeScript type. */
export const blockingQuestionWithdrawSchema = z.union([
  z.object({}).strict(),
  blockingQuestionWithdrawalSchema,
]);

/** Decode a withdrawal WIRE body to its semantic state: the typed payload,
 *  or `undefined` for a plain withdrawal. The one producer of that state —
 *  a consumer never re-derives it with its own property-presence guard
 *  (review finding: a route-local `"reason" in body` branch can drift from
 *  the schema it shadows). Throws on an invalid body, exactly as parsing
 *  does. */
export function parseBlockingQuestionWithdraw(
  body: unknown
): BlockingQuestionWithdrawal | undefined {
  const parsed = blockingQuestionWithdrawSchema.parse(body ?? {});
  // The union is strict-{} or the complete payload, so key-count is the
  // discriminant (`in` cannot narrow the zod-inferred Record type).
  return Object.keys(parsed).length > 0
    ? (parsed as BlockingQuestionWithdrawal)
    : undefined;
}

/** Same bounds as a peer message — it is the same class of surface (D2). */
export const MAX_QUESTION_SUBJECT_CHARS = MAX_PEER_SUBJECT_CHARS;
export const MAX_QUESTION_BODY_CHARS = MAX_PEER_BODY_CHARS;
export const MAX_ANSWER_CHARS = MAX_PEER_BODY_CHARS;
/** Open questions one job may hold at once; asking past it refuses. */
export const MAX_OPEN_QUESTIONS_PER_JOB = 8;
/** Anti-flood fence between two asks from one job — same shape as A2A's
 *  send fence; without it, ask/withdraw churn can push a task's spine past
 *  the read window (review pass 7 HIGH #2). */
export const MIN_QUESTION_ASK_INTERVAL_MS = 250;


/**
 * Dangerous code points come from the ONE shared class in
 * `evasion-corpus.ts` — never a second hand-written character range here.
 *
 * A SUBJECT preserves nothing: it is one row on an operator surface, and an
 * interior newline forged a whole fake row with an attacker-chosen id
 * (review pass 7 HIGH #1, demonstrated). A BODY preserves newline and tab so
 * a real report stays readable, and nothing else.
 *
 * Widened from C0/C1 to the full class the first time the round-3 #8 corpus
 * replayed against it: a zero-width directive, a soft-hyphen split and a bidi
 * override all passed the old regex and reached the operator inbox. Sharing
 * the definition is what stops that class of gap reopening one surface at a
 * time.
 */
const BODY_PRESERVES: ReadonlySet<string> = new Set(["\n", "\t"]);
const PRESERVE_NOTHING: ReadonlySet<string> = new Set();

function carriesDangerous(
  value: string,
  preserved: ReadonlySet<string>
): boolean {
  for (const character of value) {
    if (preserved.has(character)) continue;
    const code = character.codePointAt(0);
    if (code !== undefined && isDangerousCodePoint(code)) return true;
  }
  return false;
}

/**
 * What an AGENT may send. Deliberately missing: every identity and scope
 * field (job, task, chat, role, vendor are server-derived from the bearer,
 * exactly as A2A does), and any deadline/priority lever (D5).
 */
export const blockingQuestionAskSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1)
      .max(MAX_QUESTION_SUBJECT_CHARS)
      .refine((value) => !carriesDangerous(value, PRESERVE_NOTHING), {
        message:
          "subject must be one line of plain text: no control, bidi, or invisible format characters",
      }),
    body: z
      .string()
      .trim()
      .min(1)
      .max(MAX_QUESTION_BODY_CHARS)
      .refine((value) => !carriesDangerous(value, BODY_PRESERVES), {
        message:
          "body admits newlines and tabs only — no other control, bidi, or invisible format characters",
      }),
  })
  .strict();
export type BlockingQuestionAsk = z.infer<typeof blockingQuestionAskSchema>;

/** What an OPERATOR may send when answering. */
export const blockingQuestionAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(MAX_ANSWER_CHARS),
  })
  .strict();
export type BlockingQuestionAnswer = z.infer<
  typeof blockingQuestionAnswerSchema
>;

export const blockingQuestionStatusSchema = z.enum([
  "open",
  "answered",
  "withdrawn",
]);
export type BlockingQuestionStatus = z.infer<
  typeof blockingQuestionStatusSchema
>;

/** The derived, delivered fact. Identity fields are server-derived. */
export const blockingQuestionSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    jobId: z.string().min(1),
    /** Optional: a solo job with no crew role can still be blocked on a
     *  human — refusing it here would exclude the commonest case. */
    askedByRole: agentRoleSchema.optional(),
    askedByVendor: z.string().min(1).max(64),
    subject: z.string().min(1).max(MAX_QUESTION_SUBJECT_CHARS),
    /** UNTRUSTED agent text (D2). Render, never execute. */
    body: z.string().min(1).max(MAX_QUESTION_BODY_CHARS),
    status: blockingQuestionStatusSchema,
    askedAt: z.string().min(1),
    answeredAt: z.string().min(1).optional(),
    /** Operator-authored. Present exactly when status is "answered". */
    answer: z.string().min(1).max(MAX_ANSWER_CHARS).optional(),
    /** Provenance the FOLD verified (a "human" principal on the answered
     *  row), not a literal a surface asserts (review pass 7 #3). */
    answeredBy: z.literal("operator").optional(),
    /** ADR-0069: the brain's recall answer, filed by the server beside the
     *  ask. Context for both sides; grants nothing, closes nothing. */
    memoryPreAnswer: questionMemoryPreAnswerSchema.optional(),
    /** ADR-0082: the crew's working knowledge beside the ask — labeled
     *  context that can NEVER close a question (`answered_from_memory`
     *  stays confirmed-only; the withdrawal's citation binding refuses
     *  crew ids structurally, since they are not in the DISCLOSED
     *  pre-answer set). */
    crewContext: questionCrewContextSchema.optional(),
    /** ADR-0069 D2: present when the asker withdrew because the pre-answer
     *  settled it — recorded, cited, never a human close. PRESERVED through
     *  an operator override (below): the overridden memory answer and its
     *  citations are the override's provenance, not discarded history. */
    withdrawnReason: z
      .literal(QUESTION_WITHDRAW_REASON_ANSWERED_FROM_MEMORY)
      .optional(),
    withdrawnCitedNoteIds: z
      .array(z.string().min(1).max(128))
      .max(MAX_PREANSWER_NOTES)
      .optional(),
    /** ADR-0069 D2's override leg: the human answered a question the asker
     *  had closed from memory — the ONE legal second terminal. Derived by
     *  the fold from the prior state, never asserted by a writer. The
     *  server files the contradiction proposal against the cited notes
     *  beside this transition ("the brain learns it was stale the moment
     *  it misleads"). */
    overrodeMemoryAnswer: z.literal(true).optional(),
  })
  .strict();
export type BlockingQuestion = z.infer<typeof blockingQuestionSchema>;

/** The minimal event shape the derivation needs — matches the Event spine. */
export type QuestionSpineEvent = {
  readonly kind: string;
  readonly taskId: string;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
  /** The audit-stamped actor kind of the row ("human" | "agent" | …).
   *  REQUIRED for an answer to count: the fold verifies provenance itself
   *  instead of trusting the event kind (review pass 7 #3 — the writers
   *  enforce it today, but bounded-surface doctrine closes it at the fold). */
  readonly principalKind?: string | null;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Fold the event spine into current question states.
 *
 * Rules, each fail-closed:
 *  - a malformed `question.blocked` row (missing any required coordinate or
 *    over-bound text) derives NOTHING — a corrupt row cannot half-exist;
 *  - an answer or withdrawal for an id no open row established is ignored;
 *  - a second terminal event for the same id is ignored (first one wins) —
 *    an answered question cannot be re-opened or silently re-answered;
 *  - order is the caller's event order (the spine is timestamp-ascending).
 */
export function deriveBlockingQuestions(
  events: readonly QuestionSpineEvent[]
): BlockingQuestion[] {
  const byId = new Map<string, BlockingQuestion>();
  for (const event of events) {
    const meta = event.metadata ?? {};
    if (event.kind === QUESTION_BLOCKED_EVENT_KIND) {
      const id = str(meta.questionId);
      if (!id || byId.has(id)) continue;
      // An unrecognized role label drops the LABEL, not the fact — the role
      // is optional decoration; subject/body/coordinates are load-bearing.
      const role = agentRoleSchema.safeParse(str(meta.role));
      const candidate = blockingQuestionSchema.safeParse({
        id,
        taskId: event.taskId,
        jobId: str(meta.jobId) ?? undefined,
        ...(role.success ? { askedByRole: role.data } : {}),
        askedByVendor: str(meta.vendor) ?? undefined,
        subject: str(meta.subject) ?? undefined,
        body: str(meta.body) ?? undefined,
        status: "open",
        askedAt: event.timestamp,
      });
      if (candidate.success) byId.set(id, candidate.data);
      continue;
    }
    if (event.kind === QUESTION_ANSWERED_EVENT_KIND) {
      const id = str(meta.questionId);
      const open = id ? byId.get(id) : undefined;
      const answer = str(meta.answer);
      // ADR-0069 D2's override leg: the ONE legal second terminal. A human
      // answer lands on an OPEN question, or on one the ASKER closed from
      // memory ("the human may override; an override supersedes the memory
      // answer"). A plain withdrawal and an existing answer stay terminal.
      const overriding = open !== undefined && canOverrideMemoryAnswer(open);
      // The fold checks the ACTOR, not just the kind: an answered row whose
      // audit stamp is not a human principal is ignored, so `answeredBy:
      // "operator"` below is a verified fact, never an asserted literal.
      if (
        !open ||
        (open.status !== "open" && !overriding) ||
        !answer ||
        event.principalKind !== "human"
      ) {
        continue;
      }
      byId.set(open.id, {
        ...open,
        status: "answered",
        answeredBy: "operator",
        answeredAt: event.timestamp,
        answer: answer.slice(0, MAX_ANSWER_CHARS),
        // Derived from the PRIOR state, never from writer metadata — the
        // withdrawn reason + citations survive the spread as the override's
        // provenance.
        ...(overriding ? { overrodeMemoryAnswer: true as const } : {}),
      });
      continue;
    }
    if (event.kind === QUESTION_CREW_CONTEXT_EVENT_KIND) {
      const id = str(meta.questionId);
      const target = id ? byId.get(id) : undefined;
      // Same posture as the pre-answer: first disclosure wins; a malformed
      // payload derives nothing; deliberately NOT gated on the question
      // still being open (it files outside the ask transaction, and a
      // disclosure that raced a fast answer is still true history).
      if (!target || target.crewContext) continue;
      const parsed = questionCrewContextSchema.safeParse({
        items: meta.items,
        disclosedAt: event.timestamp,
      });
      if (parsed.success) {
        byId.set(target.id, { ...target, crewContext: parsed.data });
      }
      continue;
    }
    if (event.kind === QUESTION_PREANSWER_EVENT_KIND) {
      const id = str(meta.questionId);
      const target = id ? byId.get(id) : undefined;
      // First pre-answer wins; a malformed payload derives nothing (a
      // corrupt row cannot half-exist). DELIBERATELY not gated on the
      // question still being open: the pre-answer files fail-open OUTSIDE
      // the ask transaction, so a human may answer in the gap — the
      // disclosure still happened and stays true history on the terminal
      // question rather than an orphaned row the fold ignores.
      if (!target || target.memoryPreAnswer) continue;
      const parsed = questionMemoryPreAnswerSchema.safeParse({
        notes: meta.notes,
        disclosedAt: event.timestamp,
      });
      if (parsed.success) {
        byId.set(target.id, { ...target, memoryPreAnswer: parsed.data });
      }
      continue;
    }
    if (event.kind === QUESTION_WITHDRAWN_EVENT_KIND) {
      const id = str(meta.questionId);
      const open = id ? byId.get(id) : undefined;
      if (!open || open.status !== "open") continue;
      // ADR-0069 D2: a typed reason + citations survive the fold; anything
      // else stays a plain withdrawal (unknown reasons are dropped, not
      // invented). The fold BINDS citations to the question's own disclosed
      // pre-answer (review finding: an arbitrary id on the spine is false
      // provenance) — the route refuses foreign ids too, but the fold is
      // the reader of record and defends itself.
      const reason = str(meta.reason);
      const disclosed = new Set(
        (open.memoryPreAnswer?.notes ?? []).map((note) => note.noteId)
      );
      const cited = Array.isArray(meta.citedNoteIds)
        ? (meta.citedNoteIds as unknown[])
            .filter(
              (value): value is string =>
                typeof value === "string" &&
                value.length > 0 &&
                disclosed.has(value)
            )
            .slice(0, MAX_PREANSWER_NOTES)
        : [];
      byId.set(open.id, {
        ...open,
        status: "withdrawn",
        ...(reason === QUESTION_WITHDRAW_REASON_ANSWERED_FROM_MEMORY &&
        cited.length > 0
          ? {
              withdrawnReason: QUESTION_WITHDRAW_REASON_ANSWERED_FROM_MEMORY,
              withdrawnCitedNoteIds: cited,
            }
          : {}),
      });
    }
  }
  return [...byId.values()];
}

/** ADR-0069 D2's override precondition — THE one spelling (review finding:
 *  the fold and the answer route each derived it with their own predicate,
 *  free to drift). True exactly when a human answer may legally land as the
 *  second terminal: the ASKER closed the question from memory. */
export function canOverrideMemoryAnswer(
  question: Pick<BlockingQuestion, "status" | "withdrawnReason">
): boolean {
  return (
    question.status === "withdrawn" &&
    question.withdrawnReason === QUESTION_WITHDRAW_REASON_ANSWERED_FROM_MEMORY
  );
}

/** The open subset — what the inbox shows and what the per-job cap counts. */
export function openBlockingQuestions(
  events: readonly QuestionSpineEvent[]
): BlockingQuestion[] {
  return deriveBlockingQuestions(events).filter(
    (question) => question.status === "open"
  );
}
