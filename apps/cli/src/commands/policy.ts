import { readFileSync } from "node:fs";
import { failCommand } from "../lib/refusal.js";
import path from "node:path";
import type { Command } from "commander";
import {
  POLICY_ACTION_CLASSES,
  defaultPolicyProfile,
  policyActionClassSchema,
  policyProfileSchema,
  type PolicyActionClass,
  type PolicyProfile,
} from "@muon/protocol";
import { simulatePolicy, type PolicySimulation } from "@muon/core";
import type { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

/** Load + validate a policy profile JSON from disk. Throws a bounded message. */
function loadProfile(file: string): PolicyProfile {
  const resolved = path.resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read policy profile at ${resolved}: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`
    );
  }
  const parsed = policyProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (at ${issue.path.join(".")})` : "";
    throw new Error(
      `Invalid policy profile${where}: ${issue?.message ?? "does not match the policy schema"}`
    );
  }
  return parsed.data;
}

/** Which action classes to explain: one (validated) or the whole canonical set. */
function resolveClasses(action?: string): PolicyActionClass[] {
  if (action === undefined) {
    return [...POLICY_ACTION_CLASSES];
  }
  const parsed = policyActionClassSchema.safeParse(action);
  if (!parsed.success) {
    throw new Error(
      `Unknown action class '${action}'. Expected one of: ${POLICY_ACTION_CLASSES.join(", ")}.`
    );
  }
  return [parsed.data];
}

/**
 * The profile to explain, plus honest provenance. `--workspace` resolves the
 * STORED (enforced) profile from the brain; anything else — no row, invalid
 * row, unreachable brain — degrades to the dry-run fallback exactly like the
 * runner does (never a lockout, never an implied enforcement).
 */
type ResolvedProfile = {
  profile: PolicyProfile;
  source: string;
  /** True ONLY when a stored workspace/task profile was resolved. */
  enforced: boolean;
};

async function resolveProfile(
  options: { profile?: string; workspace?: string },
  createClient?: () => MuonApiClient
): Promise<ResolvedProfile> {
  let workspaceNote: string | null = null;
  if (options.workspace && createClient) {
    try {
      const record = await createClient().getWorkspacePolicy({
        workspacePath: options.workspace,
      });
      const parsed =
        record.profile !== null && record.profile !== undefined
          ? policyProfileSchema.safeParse(record.profile)
          : null;
      if (parsed?.success && record.scope) {
        return {
          profile: parsed.data,
          source: `stored ${record.scope} profile for ${options.workspace} (v${record.version})`,
          enforced: true,
        };
      }
      workspaceNote =
        parsed === null
          ? `no stored profile for ${options.workspace}`
          : `stored profile for ${options.workspace} is invalid; ignoring it`;
    } catch (error) {
      workspaceNote = `stored profile unavailable (${
        error instanceof Error ? error.message : "brain unreachable"
      })`;
    }
  } else if (options.workspace) {
    workspaceNote = "no brain client configured for --workspace";
  }

  const fallback: ResolvedProfile = options.profile
    ? {
        profile: loadProfile(options.profile),
        source: `profile file ${options.profile}`,
        enforced: false,
      }
    : {
        profile: defaultPolicyProfile,
        source: "built-in default profile",
        enforced: false,
      };
  if (workspaceNote) {
    fallback.source = `${workspaceNote}; using ${fallback.source}`;
  }
  return fallback;
}

/** Human-readable rendering of a profile's posture over the classes. */
function renderExplain(resolved: ResolvedProfile, rows: PolicySimulation[]): string {
  const { profile } = resolved;
  const radius =
    profile.taskRadius.length > 0
      ? profile.taskRadius.join(", ")
      : "(none configured — every edit is treated as outside)";
  const lines = [
    `MUON policy posture — profile "${profile.label}" (v${profile.version}, ${
      resolved.enforced ? "enforced" : "dry-run"
    })`,
    `Source: ${resolved.source}`,
    `Task radius: ${radius}`,
    `Edits inside the task radius: ${profile.editInRadius}`,
    "",
    ...rows.map(
      (row) =>
        `  ${row.actionClass.padEnd(8)} ${row.decision.padEnd(6)} ${row.reason}`
    ),
    "",
    resolved.enforced
      ? "Enforced for interactive sessions in this workspace."
      : "Dry-run only: this explains posture; it changes no gate or approval behavior.",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * `muon policy` — P0.4.
 *
 * `explain` renders `simulatePolicy` over a profile, for one action class or
 * all of them. Without `--workspace` it is STRICTLY offline/dry-run (a file or
 * the built-in default). With `--workspace` it fetches the STORED profile —
 * the one the runner actually enforces for interactive sessions — and says so;
 * any resolution failure degrades honestly back to the dry-run fallback.
 *
 * `receipts` lists the live, content-bound, expiring receipts (read-only; a
 * receipt is only ever minted by an explicit operator opt-in on a decision).
 */
export function registerPolicyCommand(
  program: Command,
  createClient?: () => MuonApiClient
) {
  const policy = program
    .command("policy")
    .description("Inspect MUON's workspace policy posture and live receipts");

  policy
    .command("explain")
    .description(
      "Explain what the policy would decide per action class (stored profile with --workspace; otherwise dry-run)"
    )
    .option(
      "--action <class>",
      `limit to one action class (${POLICY_ACTION_CLASSES.join("|")})`
    )
    .option(
      "--profile <file>",
      "path to a JSON policy profile (default: built-in default profile)"
    )
    .option(
      "--workspace <path>",
      "explain the STORED profile governing this workspace (falls back to --profile, then the default)"
    )
    .option("--json", "print the simulation as JSON")
    .action(
      async (options: {
        action?: string;
        profile?: string;
        workspace?: string;
        json?: boolean;
      }) => {
        try {
          const resolved = await resolveProfile(options, createClient);
          const rows = resolveClasses(options.action).map((actionClass) =>
            simulatePolicy({ class: actionClass }, resolved.profile)
          );

          if (options.json) {
            printJson({
              profile: {
                version: resolved.profile.version,
                label: resolved.profile.label,
                editInRadius: resolved.profile.editInRadius,
                taskRadius: resolved.profile.taskRadius,
              },
              source: resolved.source,
              enforced: resolved.enforced,
              simulations: rows,
            });
            return;
          }
          process.stdout.write(renderExplain(resolved, rows));
        } catch (error) {
          failCommand(error, "Failed to explain the policy.");
        }
      }
    );

  policy
    .command("receipts")
    .description(
      "List live approval receipts (content-bound, expiring; minted only by explicit operator opt-in)"
    )
    .option("--workspace <path>", "limit to one governed workspace")
    .option("--json", "print receipts as JSON")
    .action(async (options: { workspace?: string; json?: boolean }) => {
      try {
        if (!createClient) {
          throw new Error("policy receipts needs a brain connection");
        }
        const receipts = await createClient().listReceipts({
          activeOnly: true,
          workspacePath: options.workspace,
        });

        if (options.json) {
          printJson({ receipts });
          return;
        }
        if (receipts.length === 0) {
          process.stdout.write(
            "No live receipts. A receipt exists only after you opt in on an approval.\n"
          );
          return;
        }
        const lines = receipts.map(
          (receipt) =>
            `- ${receipt.id} | ${receipt.toolName} (${receipt.actionClass}) | digest ${receipt.payloadDigest.slice(0, 12)}… | ${receipt.workspacePath} | expires ${receipt.expiresAt} | used ${receipt.useCount}x`
        );
        process.stdout.write(
          `${receipts.length} live receipt${receipts.length === 1 ? "" : "s"} (content-bound, single-run, expiring):\n${lines.join("\n")}\n`
        );
      } catch (error) {
        failCommand(error, "Failed to list receipts.");
      }
    });

  policy
    .command("set")
    .description(
      "Store a policy profile for a workspace (operator only). The strict schema rejects allow-on-network/merge/ship, so an over-permissive posture can never be stored."
    )
    .requiredOption("--workspace <path>", "the workspace this profile governs")
    .requiredOption("--profile <file>", "path to a JSON policy profile")
    .option(
      "--task-id <id>",
      "scope the profile to one task (default: the whole workspace)"
    )
    .option("--json", "print the stored result as JSON")
    .action(
      async (options: {
        workspace: string;
        profile: string;
        taskId?: string;
        json?: boolean;
      }) => {
        try {
          if (!createClient) {
            throw new Error("policy set needs a brain connection");
          }
          const profile = loadProfile(options.profile);
          const result = await createClient().putWorkspacePolicy({
            workspacePath: options.workspace,
            profile,
            taskId: options.taskId,
          });
          if (options.json) {
            printJson(result);
            return;
          }
          const label =
            (result.profile as { label?: string }).label ?? "profile";
          process.stdout.write(
            `✓ stored ${result.scope} policy "${label}" v${result.version} for ${options.workspace}\n`
          );
        } catch (error) {
          failCommand(error, "Failed to store the policy.");
        }
      }
    );

  policy
    .command("unset")
    .description(
      "Remove a stored policy profile → the workspace degrades to ask-everything (never a lockout, never an auto-allow)."
    )
    .requiredOption("--workspace <path>", "the workspace to clear")
    .option(
      "--task-id <id>",
      "clear only this task's profile (default: the workspace profile)"
    )
    .action(async (options: { workspace: string; taskId?: string }) => {
      try {
        if (!createClient) {
          throw new Error("policy unset needs a brain connection");
        }
        const { deleted } = await createClient().deleteWorkspacePolicy({
          workspacePath: options.workspace,
          taskId: options.taskId,
        });
        // Review (control-F3): name the EXACT scope removed. A workspace unset
        // deletes only the workspace-level row; task-scoped profiles for that
        // workspace survive and keep enforcing, so "back to ask-everything" was
        // misleading.
        process.stdout.write(
          deleted > 0
            ? options.taskId
              ? `✓ removed task ${options.taskId}'s profile; that task now follows the workspace profile (or ask-everything if none).\n`
              : `✓ removed the workspace profile for ${options.workspace}; any task-scoped profiles for it still apply.\n`
            : `No stored profile for ${options.workspace}${
                options.taskId ? ` (task ${options.taskId})` : ""
              }.\n`
        );
      } catch (error) {
        failCommand(error, "Failed to remove the policy.");
      }
    });

  policy
    .command("revoke")
    .description(
      "Revoke a live approval receipt (the human's kill switch; one-way, idempotent)."
    )
    .requiredOption("--receipt-id <id>", "the receipt to revoke")
    .action(async (options: { receiptId: string }) => {
      try {
        if (!createClient) {
          throw new Error("policy revoke needs a brain connection");
        }
        const receipt = await createClient().revokeReceipt(options.receiptId);
        process.stdout.write(
          `✓ revoked receipt ${receipt.id} (${receipt.toolName}); it can no longer be redeemed.\n`
        );
      } catch (error) {
        failCommand(error, "Failed to revoke the receipt.");
      }
    });
}
