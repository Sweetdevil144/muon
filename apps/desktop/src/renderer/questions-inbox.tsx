import { useState } from "react";
import type { BlockingQuestion } from "@muon/client";

/**
 * ADR-0043's missing half (surface-parity audit 2026-08-11): agents file
 * BLOCKING questions and, until this panel, only the CLI could see or answer
 * them — an agent sat blocked while the desk showed nothing.
 *
 * Trust posture, same as every question surface: subject and body are
 * AGENT-PRODUCED UNTRUSTED TEXT. React's escaping neutralizes markup; they are
 * rendered as text nodes, never interpreted, never treated as a directive to
 * MUON. Answering confers no authority — one operator-authored event, no
 * receipt, no grant (the backend enforces this; the copy here just says it).
 */
export function QuestionsInbox(props: {
  questions: BlockingQuestion[];
  /** The read is bounded; true = this list may be PARTIAL (cubic P1). */
  truncated?: boolean;
  /** The read failed; distinct from "no questions" (cubic P1). */
  unavailable?: boolean;
  /** Chat-scoped task ids, so the active mission's questions sort first. */
  activeTaskIds: ReadonlySet<string>;
  onAnswer: (input: {
    questionId: string;
    taskId: string;
    answer: string;
  }) => Promise<{ answered: boolean }>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Per-question, not a single id: two overlapping answers must not re-arm
  // each other's cards mid-flight (cubic P2).
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Optimistic dismissal: an accepted answer removes its card immediately, so
  // the operator cannot re-submit into a guaranteed 409 while the next poll
  // is still on its way (cubic P2).
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());

  if (props.unavailable) {
    return (
      <details className="dock-collapsible questions-inbox" open>
        <summary>Questions from agents</summary>
        <div className="question-error">
          The questions inbox could not be read — an empty list here would be
          a lie. Check the brain connection, or use `muon questions`.
        </div>
      </details>
    );
  }
  const visible = props.questions.filter(
    (question) => !answered.has(question.id)
  );
  if (visible.length === 0 && !props.truncated) {
    return null;
  }
  const ordered = [...visible].sort((left, right) => {
    const leftActive = props.activeTaskIds.has(left.taskId) ? 0 : 1;
    const rightActive = props.activeTaskIds.has(right.taskId) ? 0 : 1;
    if (leftActive !== rightActive) return leftActive - rightActive;
    return left.askedAt < right.askedAt ? 1 : -1;
  });

  return (
    <details className="dock-collapsible questions-inbox" open>
      <summary>
        Questions from agents
        <span className="questions-count">{visible.length}</span>
      </summary>
      {props.truncated ? (
        <div className="question-error">
          Inbox truncated — older open questions may exist. See `muon
          questions list --task-id …` for a full per-task read.
        </div>
      ) : null}
      <div className="questions-list">
        {ordered.map((question) => {
          const draft = drafts[question.id] ?? "";
          const error = errors[question.id];
          return (
            <div className="question-card" key={question.id}>
              <div className="question-head">
                <span className="question-vendor">
                  {question.askedByVendor}
                  {question.askedByRole ? ` · ${question.askedByRole}` : ""}
                </span>
                {props.activeTaskIds.has(question.taskId) ? (
                  <span className="question-chip active">this mission</span>
                ) : (
                  <span className="question-chip">other mission</span>
                )}
              </div>
              <div className="question-subject">{question.subject}</div>
              <div className="question-body">{question.body}</div>
              <textarea
                className="question-answer"
                placeholder="Your decision, in plain words — delivered to the agent as data."
                rows={2}
                value={draft}
                onChange={(event) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [question.id]: event.target.value,
                  }))
                }
              />
              {error ? <div className="question-error">{error}</div> : null}
              <button
                className="question-send"
                disabled={busy.has(question.id) || draft.trim().length === 0}
                onClick={() => {
                  setBusy((prev) => new Set(prev).add(question.id));
                  setErrors((prev) => ({ ...prev, [question.id]: "" }));
                  props
                    .onAnswer({
                      questionId: question.id,
                      taskId: question.taskId,
                      answer: draft.trim(),
                    })
                    .then((result) => {
                      if (result.answered) {
                        setAnswered((prev) =>
                          new Set(prev).add(question.id)
                        );
                      } else {
                        setErrors((prev) => ({
                          ...prev,
                          [question.id]:
                            "The question is no longer open (answered or withdrawn elsewhere).",
                        }));
                      }
                    })
                    .catch((cause) => {
                      setErrors((prev) => ({
                        ...prev,
                        [question.id]:
                          cause instanceof Error
                            ? cause.message
                            : "Answer failed.",
                      }));
                    })
                    .finally(() =>
                      setBusy((prev) => {
                        const next = new Set(prev);
                        next.delete(question.id);
                        return next;
                      })
                    );
                }}
              >
                {busy.has(question.id) ? "Answering…" : "Answer"}
              </button>
            </div>
          );
        })}
      </div>
    </details>
  );
}
