import { z } from "zod";
import type { Command } from "commander";
import { MuonApiClient } from "../lib/api-client.js";
import { printApproval, printError, printJson } from "../lib/output.js";
import type { ApprovalKind } from "../types.js";
import type { ReviewCoverageCertification } from "@muon/client";
import {
  APPROVAL_GRANT_DURATIONS,
  approvalGrantDurationSchema,
  type ApprovalGrantDuration,
} from "@muon/protocol";
import { buildApprovalDecision } from "@muon/client";
import { failCommand, exitCodeForError, formatRefusal } from "../lib/refusal.js";

const kindSchema = z.enum(["merge", "command", "deploy", "dangerous_action"]);
const statusSchema = z.enum(["approved", "rejected"]);

function printReviewCertification(
  certification: ReviewCoverageCertification
) {
  process.stdout.write(
    `status=${certification.status} artifact=${certification.artifactDigest}\n`
  );
  if (certification.status === "certified") {
    process.stdout.write(
      `verdict=${certification.verdict} changed=${certification.changedFiles.length}\n`
    );
    return;
  }
  process.stdout.write(
    `block=${certification.blockCode} reason=${certification.reason}\n`
  );
  for (const file of certification.blindFiles ?? []) {
    process.stdout.write(`blind ${file}\n`);
  }
}

export function registerApproveCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const approve = program.command("approve").description("Approval queue commands");

  approve
    .command("list")
    .description("List approvals")
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const approvals = await createClient().listApprovals();
        if (options.json) {
          printJson({ approvals });
          return;
        }

        approvals.forEach(printApproval);
      } catch (error) {
        failCommand(error, "Failed to list approvals.");
      }
    });

  approve
    .command("request")
    .description("Create an approval request")
    .requiredOption("--task-id <taskId>", "Task identifier")
    .requiredOption("--requested-by <requestedBy>", "Requester lane or actor")
    .requiredOption(
      "--kind <kind>",
      "Approval kind: merge | command | deploy | dangerous_action"
    )
    .requiredOption("--reason <reason>", "Reason for approval")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        taskId: string;
        requestedBy: string;
        kind: ApprovalKind;
        reason: string;
        json?: boolean;
      }) => {
        try {
          const approval = await createClient().requestApproval({
            taskId: options.taskId,
            requestedBy: options.requestedBy,
            kind: kindSchema.parse(options.kind),
            reason: options.reason,
          });

          if (options.json) {
            printJson({ approval });
            return;
          }

          printApproval(approval);
        } catch (error) {
          failCommand(error, "Failed to request approval.");
        }
      }
    );

  approve
    .command("review")
    .description(
      "Load the server-derived merge review, including exact artifact digest and REVIEW BLIND files"
    )
    .requiredOption("--approval-id <approvalId>", "Merge approval identifier")
    .option("--json", "Print as JSON")
    .action(async (options: { approvalId: string; json?: boolean }) => {
      try {
        const certification =
          await createClient().getApprovalReviewCertification(
            options.approvalId
          );
        if (options.json) {
          printJson({ certification });
          return;
        }
        printReviewCertification(certification);
      } catch (error) {
        failCommand(error, "Failed to load merge review.");
      }
    });

  approve
    .command("resolve")
    .description("Resolve an approval request")
    .requiredOption("--approval-id <approvalId>", "Approval identifier")
    .requiredOption("--status <status>", "approved | rejected")
    .option("--notes <decisionNotes>", "Decision notes")
    .option(
      "--remember <ttlMs>",
      "mint a content-bound expiring receipt (60000-3600000 ms) so this EXACT action is auto-allowed until it expires; never a blanket allow"
    )
    .option(
      "--remember-scope <once|session|always>",
      "ADR-0056 graded form of --remember: once (nothing is remembered), session (this run, 1h), always (this exact action in this chat, 7 days, revocable). The expiry is server-computed."
    )
    .option(
      "--attest-review-blind <artifactDigest>",
      "after `muon approve review`, attest that every listed blind file was manually reviewed for this exact artifact digest"
    )
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        approvalId: string;
        status: "approved" | "rejected";
        notes?: string;
        remember?: string;
        rememberScope?: string;
        attestReviewBlind?: string;
        json?: boolean;
      }) => {
        try {
          let receipt: { ttlMs: number } | undefined;
          let grant: { duration: ApprovalGrantDuration } | undefined;
          let manualReview:
            | {
                acknowledged: true;
                artifactDigest: string;
                blindFiles: string[];
              }
            | undefined;
          if (options.remember !== undefined) {
            // Review (control-F2): a receipt is a "remember this APPROVAL" opt-in.
            // The backend only mints/skip-signals on an approved decision, so a
            // `--remember` on a rejection was silently dropped with no note. Fail
            // fast and honestly instead of pretending it was honored.
            if (options.status === "rejected") {
              throw new Error(
                "--remember only applies to an approval; a rejection cannot be remembered (drop --remember, or use --status approved)."
              );
            }
            const ttlMs = Number(options.remember);
            if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 3_600_000) {
              throw new Error(
                "--remember must be an integer of 60000-3600000 milliseconds (1 minute to 1 hour)."
              );
            }
            receipt = { ttlMs };
          }
          if (options.rememberScope !== undefined) {
            // Same "a rejection cannot be remembered" rule as --remember, and
            // the two flags are mutually exclusive: the server refuses both, so
            // refuse here too rather than letting a surface pick one silently.
            if (options.status === "rejected") {
              throw new Error(
                "--remember-scope only applies to an approval; a rejection cannot be remembered (drop --remember-scope, or use --status approved)."
              );
            }
            if (receipt) {
              throw new Error(
                "--remember and --remember-scope cannot be combined; --remember-scope is the graded replacement."
              );
            }
            const parsed = approvalGrantDurationSchema.safeParse(
              options.rememberScope
            );
            if (!parsed.success) {
              throw new Error(
                `--remember-scope must be one of ${APPROVAL_GRANT_DURATIONS.join(" | ")}.`
              );
            }
            grant = { duration: parsed.data };
          }
          const client = createClient();
          if (options.attestReviewBlind !== undefined) {
            if (options.status !== "approved") {
              throw new Error(
                "--attest-review-blind only applies to an approved merge."
              );
            }
            if (receipt || grant) {
              throw new Error(
                "--remember/--remember-scope and --attest-review-blind cannot be combined; merge/ship is never remembered."
              );
            }
            if (!/^[a-f0-9]{64}$/.test(options.attestReviewBlind)) {
              throw new Error(
                "--attest-review-blind requires the 64-character artifact digest printed by `muon approve review`."
              );
            }
            const certification =
              await client.getApprovalReviewCertification(options.approvalId);
            if (
              certification.status !== "blocked" ||
              certification.blockCode !== "review-blind" ||
              !certification.blindFiles?.length
            ) {
              throw new Error(
                certification.status === "blocked"
                  ? `Manual review cannot bypass ${certification.blockCode} evidence: ${certification.reason}`
                  : "The graph already certifies this artifact; approve without --attest-review-blind."
              );
            }
            if (
              options.attestReviewBlind !== certification.artifactDigest
            ) {
              throw new Error(
                "The supplied artifact digest is stale. Run `muon approve review` again and inspect the current blind files."
              );
            }
            manualReview = {
              acknowledged: true,
              artifactDigest: certification.artifactDigest,
              blindFiles: certification.blindFiles,
            };
          }
          // Built by the shared builder, never by hand: it is what guarantees
          // EVERY decision carries a `decisionNotes`. Sending `options.notes`
          // directly meant a `muon approve` with no --notes reached the ledger
          // with the field undefined, so a human's CLI decision was
          // indistinguishable from a scripted API call — while the same
          // decision from the TUI or desktop was attributed.
          const approval = await client.resolveApproval(
            buildApprovalDecision({
              approvalId: options.approvalId,
              status: statusSchema.parse(options.status),
              surface: "MUON CLI",
              notes: options.notes,
              ...(receipt ? { receiptTtlMs: receipt.ttlMs } : {}),
              ...(grant ? { grantDuration: grant.duration } : {}),
              ...(manualReview ? { manualReview } : {}),
            })
          );

          // P0.4: the decision always lands; a requested receipt may soft-skip
          // (the action can't be remembered) — surface that honestly, never as
          // a failure.
          if (approval.receiptSkipped) {
            process.stderr.write(
              `note: no receipt minted — ${
                approval.receiptSkippedReason ?? "this action cannot be remembered"
              }\n`
            );
          }

          // ADR-0056 D8: a grant that resolved something invisibly is the
          // failure mode, so the mint says out loud what it will cover and for
          // how long, and names the verb that kills it.
          if (approval.grant) {
            process.stderr.write(
              `granted: ${approval.grant.toolName} (${approval.grant.actionClass}) on ` +
                `${approval.grant.resolvedTarget ?? "this exact payload"} in chat ${approval.grant.taskId} ` +
                `until ${approval.grant.expiresAt} — revoke with \`muon policy revoke --grant-id ${approval.grant.id}\`\n`
            );
          }

          if (options.json) {
            printJson({ approval });
            return;
          }

          printApproval(approval);
        } catch (error) {
          // Govern verbs are exactly where a 403 is expected and exactly
           // where a raw status code is useless. `approve resolve` is THE
           // operator action, so it must name what the token can reach and
           // exit 2 (authz) rather than 1 (ordinary failure) — the contract
           // scripts gate on.
          printError(formatRefusal(error, "approve resolve"));
          process.exitCode = exitCodeForError(error);
        }
      }
    );
}
