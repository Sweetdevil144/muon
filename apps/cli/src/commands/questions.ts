import type { Command } from "commander";
import {
  answerBlockingQuestion,
  listTaskBlockingQuestions,
  terminalSafe,
  terminalSafeBlock,
  type BlockingQuestion,
} from "@muon/client";
import { resolveApiBase, resolveApiToken } from "../lib/config.js";
import { printJson } from "../lib/output.js";
import { failCommand } from "../lib/refusal.js";

/**
 * ADR-0043 — the operator half of blocking questions.
 *
 * The QUESTION subject/body are agent-produced UNTRUSTED text: rendered
 * through `terminalSafeBlock` (the same sanitizer every transcript surface
 * uses), never executed, never treated as a directive to MUON. Answering
 * confers no authority: it files one operator-authored event and nothing
 * else — no receipt, no grant, no approval.
 */
export function registerQuestionCommands(program: Command) {
  const globals = () => {
    const opts = program.opts<{ apiBase?: string; apiToken?: string }>();
    return {
      apiBase: resolveApiBase(opts.apiBase),
      apiToken: resolveApiToken(opts.apiToken, opts.apiBase),
    };
  };

  const questions = program
    .command("questions")
    .description("Blocking questions agents filed to you (ADR-0043)");

  const line = (question: BlockingQuestion) => {
    const role = question.askedByRole ? ` ${question.askedByRole}` : "";
    // SINGLE-LINE sanitizer for row fields: an interior newline in a subject
    // would forge a whole fake row with an attacker-chosen id and vendor
    // (review pass 7 HIGH #1, demonstrated). `terminalSafe` collapses it;
    // the body keeps its newlines but every line is RE-INDENTED so no line
    // of it can masquerade as a top-level row. Vendor sanitized for
    // consistency with crew-view even though it is server-derived.
    process.stdout.write(
      `${question.id}  [${question.status}]  ${terminalSafe(question.askedByVendor)}${role}  ${terminalSafe(question.subject)}\n`
    );
    const body = terminalSafeBlock(question.body)
      .split("\n")
      .map((bodyLine) => `  ${bodyLine}`)
      .join("\n");
    process.stdout.write(`${body}\n`);
    if (question.answer) {
      process.stdout.write(`  → answered: ${terminalSafe(question.answer)}\n`);
    }
  };

  questions
    .command("list")
    .description("List a task's blocking questions")
    .requiredOption("--task-id <taskId>", "Task identifier")
    .option("--open", "Only open questions")
    .option("--json", "Print as JSON")
    .action(async (options: { taskId: string; open?: boolean; json?: boolean }) => {
      try {
        const all = await listTaskBlockingQuestions({
          ...globals(),
          taskId: options.taskId,
        });
        const rows = options.open
          ? all.filter((question) => question.status === "open")
          : all;
        if (options.json) {
          printJson({ questions: rows });
          return;
        }
        if (rows.length === 0) {
          process.stdout.write("no blocking questions\n");
          return;
        }
        rows.forEach(line);
      } catch (error) {
        failCommand(error, "Failed to list blocking questions.");
      }
    });

  questions
    .command("answer")
    .description("Answer one open blocking question (operator authority)")
    .requiredOption("--task-id <taskId>", "Task identifier")
    .requiredOption("--id <questionId>", "Question identifier")
    .requiredOption("--answer <text>", "Your answer (delivered to the agent as data)")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        taskId: string;
        id: string;
        answer: string;
        json?: boolean;
      }) => {
        try {
          const question = await answerBlockingQuestion({
            ...globals(),
            questionId: options.id,
            taskId: options.taskId,
            answer: options.answer,
          });
          if (options.json) {
            printJson({ question });
            return;
          }
          if (question) {
            process.stdout.write(
              `answered ${question.id} — the agent reads it on its next question_status pull\n`
            );
          }
        } catch (error) {
          failCommand(error, "Failed to answer the question.");
        }
      }
    );
}
