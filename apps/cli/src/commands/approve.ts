import { z } from "zod";
import type { Command } from "commander";
import { MuonApiClient } from "../lib/api-client.js";
import { printApproval, printError, printJson } from "../lib/output.js";
import type { ApprovalKind } from "../types.js";
import type { ReviewCoverageCertification } from "@muon/client";
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
        attestReviewBlind?: string;
        json?: boolean;
      }) => {
        try {
          let receipt: { ttlMs: number } | undefined;
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
          const client = createClient();
          if (options.attestReviewBlind !== undefined) {
            if (options.status !== "approved") {
              throw new Error(
                "--attest-review-blind only applies to an approved merge."
              );
            }
            if (receipt) {
              throw new Error(
                "--remember and --attest-review-blind cannot be combined; merge/ship is never remembered."
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
          const approval = await client.resolveApproval({
            approvalId: options.approvalId,
            status: statusSchema.parse(options.status),
            decisionNotes: options.notes,
            ...(receipt ? { receipt } : {}),
            ...(manualReview ? { manualReview } : {}),
          });

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
