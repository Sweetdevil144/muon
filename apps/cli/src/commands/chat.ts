import { createInterface } from "node:readline";
import { failCommand } from "../lib/refusal.js";
import type { Command } from "commander";
import { runChatTurn, CHAT_LANE_KEY } from "@muon/orchestrator";
import {
  buildDispatchForest,
  cancelChatJobs,
  stopThenArchiveChat,
  summarizeChatCancel,
  ChatStopBlockedError,
} from "@muon/client";
import {
  normalizeVendorAlias,
  validateModelForVendor,
} from "@muon/adapters";
import { MuonApiClient } from "../lib/api-client.js";
import { resolveApiBase, resolveAgentToken } from "../lib/config.js";
import { ensureRunner } from "../lib/ensure-runner.js";
import { collectTerminalNotices } from "../lib/job-terminal-notice.js";
import { formatDuration } from "../lib/format-duration.js";
import { printError } from "../lib/output.js";

// How often the interactive chat checks whether a delegated worker landed while
// the human was between prompts (S4 manual mirror).
const RECONCILE_POLL_MS = 2000;

/**
 * S9 budget visibility in the CLI: a one-line remaining-budget status per active
 * mission in this chat, or null when nothing has a pool yet. Derived from the
 * SAME browser-safe forest projection the desktop cockpit uses, so the numbers
 * agree. Numbers only — never agent text. Degrade-safe (a list failure → null).
 */
async function budgetStatusLine(
  client: MuonApiClient,
  chatId: string
): Promise<string | null> {
  const jobs = await client.listDispatchJobs({ chatId }).catch(() => []);
  const forest = buildDispatchForest(jobs);
  const lines: string[] = [];
  for (const mission of forest.missions) {
    const s = mission.summary;
    // Skip v1 (poolless) roots and idle missions with no spend/reservation.
    if (
      s.descendantPoolMs === null ||
      (s.reservedWallMs === 0 && s.consumedWallMs === 0 && s.active === 0)
    ) {
      continue;
    }
    lines.push(
      `budget ${mission.root.id.slice(0, 8)}: ${formatDuration(
        s.remainingWallMs
      )} remaining of ${formatDuration(s.descendantPoolMs)} ` +
        `(reserved ${formatDuration(s.reservedWallMs)}, spent ${formatDuration(
          s.consumedWallMs
        )})`
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Which chat a one-shot lifecycle act (`--cancel` / `--archive`) targets:
 * `--chat-id` when given, else the most recent ACTIVE chat for this folder.
 * Returns null after printing the reason, so the caller just exits non-zero.
 */
async function resolveLifecycleTarget(
  client: MuonApiClient,
  options: { chatId?: string; workspace?: string },
  action: string
): Promise<string | null> {
  if (options.chatId) {
    return options.chatId;
  }
  const workspacePath = options.workspace ?? process.cwd();
  const active = await client.listChats({ status: "active" });
  const mostRecent = active.find((chat) => chat.workspacePath === workspacePath);
  if (!mostRecent) {
    printError(
      `No active chat found for ${workspacePath}. Pass --chat-id to ${action} a specific chat.`
    );
    return null;
  }
  return mostRecent.id;
}

/**
 * `muon chat`, talk to the super-orchestrator like you talk to Claude.
 * The chat is bound to a workspace folder; the orchestrator creates tasks,
 * dispatches the fleet, watches streams, and files gates. You approve.
 */
export function registerChatCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  program
    .command("chat")
    .description(
      "Chat with the super-orchestrator: it plans, dispatches the fleet, and reports, gates stay yours"
    )
    .option("--workspace <dir>", "Folder the crew works in (default: cwd)")
    .option("--chat-id <id>", "Resume an existing chat")
    .option(
      "--message <text>",
      "Send one message and exit (scriptable, non-interactive)"
    )
    .option(
      "--archive",
      "Soft-delete (archive) a chat and exit; use --chat-id to pick one, else the most recent chat for this folder"
    )
    .option(
      "--cancel",
      "Stop every queued or running job in a chat and exit; the chat stays (this is not archive). Safe to run twice"
    )
    .option(
      "--model <id>",
      "Chat-level default model the orchestrator runs its turns on (e.g. opus, sonnet, haiku); validated against Claude Code"
    )
    .action(
      async (options: {
        workspace?: string;
        chatId?: string;
        message?: string;
        archive?: boolean;
        cancel?: boolean;
        model?: string;
      }) => {
        try {
          const client = createClient();
          const apiBase = resolveApiBase(
            program.opts<{ apiBase?: string }>().apiBase
          );

          // `muon chat --cancel` is the CLI half of the desktop's per-chat stop
          // (governed-op cross-surface parity): the SAME shared cancel over the
          // SAME operator-tier per-job `interrupt`. Not archive, not delete —
          // the chat is still there and still usable when this returns.
          if (options.cancel) {
            const targetId = await resolveLifecycleTarget(
              client,
              options,
              "cancel"
            );
            if (!targetId) {
              process.exitCode = 1;
              return;
            }
            const result = await cancelChatJobs(client, targetId);
            process.stdout.write(`${summarizeChatCancel(result)}\n`);
            // Fail closed for scripts: a job that would not stop is NOT success.
            if (result.blocked.length > 0) {
              process.exitCode = 1;
            }
            return;
          }

          // `muon chat --archive` is a one-shot OPERATOR act (createClient is
          // the operator client): stop the chat's work, then soft-archive it,
          // then exit. No runner or orchestrator turn is involved. Archive is
          // non-destructive — the audit trail survives — but the chat leaves
          // the default lists. If something will not stop, the archive is
          // refused and the blocking job is named (never a bare 409).
          if (options.archive) {
            const targetId = await resolveLifecycleTarget(
              client,
              options,
              "archive"
            );
            if (!targetId) {
              process.exitCode = 1;
              return;
            }
            try {
              const result = await stopThenArchiveChat(client, targetId);
              if (result.cancel.stopped.length > 0) {
                process.stdout.write(
                  `${summarizeChatCancel(result.cancel)}\n`
                );
              }
              process.stdout.write(
                `✓ archived chat ${result.chat.id} (${result.chat.title}); its history and audit trail are preserved\n`
              );
            } catch (error) {
              if (error instanceof ChatStopBlockedError) {
                printError(error.message);
                process.exitCode = 1;
                return;
              }
              throw error;
            }
            return;
          }
          // S10: the chat-level default model. Validated client-side against the
          // orchestrator's execution vendor (Claude Code) via the SAME S5
          // authority the route enforces — a fail here refuses fast (never
          // silent), a degrade warning is surfaced, and the route re-validates
          // fail-closed on every dispatch so the UI can never bypass it.
          let chatModel: string | undefined;
          if (options.model) {
            // TODO 3.3 made `VendorKey` the registry id itself, so this alias
            // resolve now succeeds for every REGISTERED vendor and the refusal
            // below is reachable only for a lane the registry does not name. It
            // is kept, not deleted: `CHAT_LANE_KEY` is a projection, and a
            // client-side check that silently degraded to "no validation" for an
            // unresolvable lane would be exactly the fail-open the route's own
            // `assertVendorHasModelCatalog` refuses. Never wave an unvalidatable
            // model through — the route re-validates fail-closed regardless.
            const coordinatorKey = normalizeVendorAlias(CHAT_LANE_KEY);
            const check = coordinatorKey
              ? validateModelForVendor(coordinatorKey, options.model)
              : {
                  ok: false as const,
                  reason: `MUON has no managed model catalog for the coordinator lane '${CHAT_LANE_KEY}', so --model cannot be validated for it`,
                };
            if (!check.ok) {
              printError(`--model rejected: ${check.reason}`);
              process.exitCode = 1;
              return;
            }
            chatModel = options.model;
            if (check.warning) {
              process.stderr.write(`⚠ ${check.warning}\n`);
            }
          }

          // RAW global flags: the resolvers pair credentials with the base, so
          // a flag-supplied base never receives the local lockfile's tokens.
          const rawFlags = program.opts<{
            apiBase?: string;
            apiToken?: string;
          }>();

          // AGENT-tier token (P3-A): injected into the orchestrator's MCP so the
          // super-agent runs WITHOUT govern authority. The human's own approvals
          // still go through `client` (operator). See resolveAgentToken.
          const apiToken = resolveAgentToken(undefined, rawFlags.apiBase);

          // Dispatches are async now, they need a persistent runner to execute
          // the queued jobs. Auto-start one so the human never has to.
          const runner = await ensureRunner(client, {
            apiBase,
            apiBaseFlag: rawFlags.apiBase,
            apiTokenFlag: rawFlags.apiToken,
          });
          if (runner.live) {
            process.stderr.write(
              runner.started
                ? "✓ started a background runner for dispatched work\n"
                : "✓ runner online\n"
            );
          } else if (runner.note) {
            process.stderr.write(`⚠ ${runner.note}\n`);
          }

          let chat = options.chatId
            ? await client.getChat(options.chatId)
            : await client.createChat({
                workspacePath: options.workspace ?? process.cwd(),
              });

          const turn = async (message: string) => {
            const result = await runChatTurn({
              client,
              chat,
              message,
              apiBase,
              apiToken,
              model: chatModel,
              onAssistantText: (text) => {
                process.stdout.write(`${text}\n`);
              },
              onStatus: (line) => {
                process.stderr.write(`${line}\n`);
              },
            });
            // A failed turn must not look like success, surface it and set
            // a non-zero exit so scripts see the failure. Always 1, never the
            // vendor's own code: 2 is reserved for governance refusals, and a
            // coordinator child exiting 2 must not impersonate one.
            if (result.exitCode !== 0) {
              process.stderr.write(
                `✗ orchestrator turn failed (vendor exit ${result.exitCode}): ${result.errorText ?? "unknown error"}\n`
              );
              process.exitCode = 1;
            }
            // Keep the resumable session id fresh for the next turn.
            chat = await client.getChat(chat.id);
            // S9: surface the mission's remaining delegation budget so the human
            // sees when a raise is worth approving (dispatches ran this turn).
            const budgetLine = await budgetStatusLine(client, chat.id);
            if (budgetLine) {
              process.stderr.write(`${budgetLine}\n`);
            }
            return result;
          };

          if (options.message) {
            await turn(options.message);
            return;
          }

          process.stderr.write(
            `chat ${chat.id}, workspace ${chat.workspacePath}\n` +
              `type instructions; /quit to exit. Gates land in your inbox (muon approve / TUI a-r).\n`
          );

          // Replay history so resumed chats read like one conversation.
          const history = await client
            .listStreamChunks({ taskId: chat.id, limit: 200 })
            .catch(() => []);
          for (const chunk of history) {
            process.stdout.write(`${chunk.content}\n`);
          }

          const rl = createInterface({
            input: process.stdin,
            output: process.stderr,
            prompt: "you ❯ ",
          });

          // S4 reconcile: the persistent runner now auto-resumes the
          // orchestrator when a delegated worker finishes, on EVERY surface
          // (task #127) — no manual nudge. So the CLI's old manual mirror is
          // retired to a pure FALLBACK: only when NO runner is online do we poll
          // and surface a "send a message to reconcile" notice. It still never
          // writes the dedupe milestone, so a live runner's (or desktop's)
          // bounded auto-continue is never suppressed. Prime `seen` with what is
          // already terminal so a resume never storms with stale completions.
          let turnInFlight = false;
          let reconcilePoll: ReturnType<typeof setInterval> | undefined;
          if (!runner.live) {
            const seenTerminalJobs = new Set<string>();
            collectTerminalNotices(
              await client
                .listDispatchJobs({ chatId: chat.id })
                .catch(() => []),
              seenTerminalJobs
            );
            reconcilePoll = setInterval(() => {
              if (turnInFlight) {
                return;
              }
              void (async () => {
                const jobs = await client
                  .listDispatchJobs({ chatId: chat.id })
                  .catch(() => []);
                const notices = collectTerminalNotices(jobs, seenTerminalJobs);
                if (notices.length > 0 && !turnInFlight) {
                  for (const notice of notices) {
                    process.stderr.write(`\n${notice}\n`);
                  }
                  // S9: a worker finishing frees budget — show the new remaining.
                  const budgetLine = await budgetStatusLine(client, chat.id);
                  if (budgetLine) {
                    process.stderr.write(`${budgetLine}\n`);
                  }
                  rl.prompt(true);
                }
              })().catch(() => {
                // A malformed job row must degrade to a missed notice — an
                // unhandled rejection here would terminate the whole
                // interactive session mid-conversation.
              });
            }, RECONCILE_POLL_MS);
            if (typeof reconcilePoll.unref === "function") {
              reconcilePoll.unref();
            }
          }

          rl.prompt();
          for await (const line of rl) {
            const message = line.trim();
            if (message === "/quit" || message === "/exit") {
              break;
            }
            if (message.length > 0) {
              turnInFlight = true;
              try {
                await turn(message);
              } catch (error) {
                process.stderr.write(
                  `✗ turn failed: ${error instanceof Error ? error.message : error}\n`
                );
              } finally {
                turnInFlight = false;
              }
            }
            rl.prompt();
          }
          if (reconcilePoll) {
            clearInterval(reconcilePoll);
          }
          rl.close();
        } catch (error) {
          failCommand(error, "Chat failed.");
        }
      }
    );
}
