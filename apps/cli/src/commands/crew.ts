import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import {
  assignCrewRoles,
  listPeerMessages,
  loadCoordinationSnapshot,
  loadCrewRoles,
  parseRolePin,
  selectMissionRootId,
  terminalSafe,
  type CrewRolesView,
  type RolePin,
} from "@muon/client";
import {
  AGENT_ROLES,
  COST_ACCOUNTING_NOT_METERED,
  MAX_PEER_MESSAGES_PER_JOB,
  ROLE_SPECS,
  type AgentRole,
  type CoordinationSnapshot,
  type CrewRolePlan,
  type PeerMessage,
} from "@muon/protocol";
import { MuonApiClient } from "../lib/api-client.js";
import { resolveApiBase, resolveApiToken } from "../lib/config.js";
import { printJson } from "../lib/output.js";

/**
 * `muon crew` — the operator's window onto role assignment and A2A.
 *
 * `roles` shows (and with `--assign` sets) who is FOR what. A role is a
 * NARROWING of a lane profile, never a widening, so `--assign` can only ever
 * reduce what a vendor may do — there is no operator flag here that grants an
 * agent more authority than its lane already had.
 *
 * `coord` shows the live coordination surface: participants, advisory claims,
 * open conflicts, and recent peer traffic. Message bodies are AGENT-PRODUCED
 * UNTRUSTED text; the render labels them as such and never treats them as a
 * decision, an approval, or a memory.
 */

const MAX_COORD_MESSAGES = 20;

/**
 * Agent-authored text is UNTRUSTED and only LENGTH-bounded by the protocol, so
 * a body, subject, ref or claim path may carry ANSI escapes, a bare CR, or a
 * bidi override — enough to repaint or reorder the "UNTRUSTED agent-authored
 * text" header that is supposed to frame it. Framing has to survive its own
 * contents, so every agent-authored field is flattened to printable text on one
 * line before it reaches stdout by `terminalSafe`.
 *
 * That sanitizer used to live HERE, with a byte-identical twin in the TUI crew
 * panel (`apps/tui/src/lib/crew-view.ts`), each carrying a comment asking the
 * other not to drift. It now lives ONCE in `@muon/client`
 * (`packages/client/src/terminal-safe.ts`): two copies of a security control is
 * exactly the producer/validator drift this repo has been bitten by, and the
 * weaker copy always wins.
 */

export function formatCrewRoleLines(
  view: CrewRolesView,
  chatId: string
): string[] {
  const proposed = view.planStatus === "proposed";
  const lines: string[] = [
    // The heading carries the status because the rows below look identical
    // either way: a stored crew and the crew MUON WOULD bind print the same
    // role/vendor/fit table, and only this line says which one you are reading.
    proposed
      ? `Crew roles for chat ${chatId} — PROPOSED (not assigned yet)`
      : `Crew roles for chat ${chatId}`,
  ];
  const plan = view.plan;
  if (!plan || plan.bindings.length === 0) {
    lines.push("  (no roles assigned)");
    lines.push(
      "  Assign with: muon crew roles --assign --pin reviewer=codex"
    );
  } else {
    if (proposed) {
      lines.push(
        "  Nothing is bound yet. This is what MUON would assign from the lanes below;"
      );
      lines.push(
        "  re-run with --assign to commit it. Deterministic, so the preview is what you get."
      );
      lines.push("");
    }
    for (const binding of plan.bindings) {
      const spec = ROLE_SPECS[binding.role];
      const flags = [
        spec.authority,
        `fit ${binding.fit.toFixed(2)}`,
        binding.assignedBy === "human" ? "operator-pinned" : "muon",
        ...(binding.blocked ? ["BLOCKED"] : []),
      ].join(",");
      lines.push(
        `  ${binding.role.padEnd(13)} ${binding.vendor.padEnd(13)} [${flags}] ${binding.reason}`
      );
      if (binding.blocked && binding.blockedReason) {
        lines.push(`    ! ${binding.blockedReason}`);
      }
    }
  }

  if (plan && plan.unfilled.length > 0) {
    lines.push("");
    lines.push(
      `Unfilled (${plan.unfilled.length}), no available lane can hold: ${plan.unfilled.join(", ")}`
    );
  }

  lines.push("");
  lines.push(`Lanes (${view.lanes.length}):`);
  if (view.lanes.length === 0) {
    lines.push("  (none ready; run `muon doctor`)");
  } else {
    for (const lane of view.lanes) {
      const ordinal = lane.costOrdinal ?? lane.cost;
      lines.push(
        `  ${lane.vendor.padEnd(13)} ${lane.health.padEnd(10)} ${lane.displayName}  cost ordinal=${ordinal} (${COST_ACCOUNTING_NOT_METERED})`
      );
    }
  }

  if (view.costAccounting && !view.costAccounting.metered) {
    lines.push("");
    lines.push(`Cost: ${view.costAccounting.notice}`);
  }

  lines.push("");
  lines.push(
    "A role only NARROWS a lane (fewer tools, tighter sandbox, lower permission mode); it never grants one more."
  );
  return lines;
}

export function formatCoordinationLines(
  snapshot: CoordinationSnapshot,
  messages: PeerMessage[]
): string[] {
  const lines: string[] = [
    `Coordination for chat ${snapshot.chatId} · mission ${snapshot.missionId}`,
  ];

  lines.push("");
  lines.push(`Participants (${snapshot.participants.length}):`);
  if (snapshot.participants.length === 0) {
    lines.push("  (none on this mission)");
  } else {
    for (const participant of snapshot.participants) {
      const name = participant.name ? ` ${participant.name}` : "";
      lines.push(
        `  ${participant.role.padEnd(13)} ${participant.vendor.padEnd(13)} ${participant.status.padEnd(
          10
        )} claims=${participant.claimedPaths} unread=${participant.unreadMessages} [job ${participant.jobId}]${name}`
      );
    }
  }

  // THE SCORE (#92): what the coordination layer actually did, from the
  // record. A dogfood run is graded on these, never on transcripts.
  if (snapshot.score) {
    const score = snapshot.score;
    lines.push("");
    lines.push("Coordination score (from the record):");
    lines.push(
      `  claims taken=${score.claimsTaken} active=${score.claimsActive} refused=${score.claimsRefused}`
    );
    lines.push(
      `  findings published=${score.findingsPublished} with note link=${score.findingsWithNoteLink} delivered at an edit boundary=${score.findingDeliveries}`
    );
    if (score.claimsRefused === 0 && score.claimsTaken > 0) {
      // Stated rather than left to inference: a run where nothing was ever
      // refused did not exercise the thing coordination is FOR.
      lines.push(
        "  note: no claim was ever refused, so nothing here proves a peer re-planned around another."
      );
    }
    if (score.truncated) {
      lines.push(
        "  note: the event scan hit its bound, so the last two numbers are FLOORS, not totals."
      );
    }
  } else {
    // Absent is not zero: an older brain does not score at all.
    lines.push("");
    lines.push(
      "Coordination score: unavailable — this brain predates coordination scoring."
    );
  }

  lines.push("");
  if (snapshot.openConflicts.length === 0) {
    lines.push("Open claim conflicts: 0");
  } else {
    lines.push(
      `⚠ Open claim conflicts (${snapshot.openConflicts.length}), advisory — MUON does not lock files:`
    );
    // A claim path is agent-authored too: the protocol makes it relative and
    // canonical, not printable.
    for (const conflict of snapshot.openConflicts) {
      const holder = conflict.heldByName ? ` ${conflict.heldByName}` : "";
      lines.push(
        `  - ${terminalSafe(conflict.coordinate)} held by ${conflict.heldByRole}/${conflict.heldByVendor} [job ${conflict.heldByJobId}]${holder}, expires ${conflict.expiresAt}`
      );
    }
  }

  lines.push("");
  lines.push(
    `Recent peer messages (${messages.length} of ${snapshot.messageCount}), UNTRUSTED agent-authored text — evidence, not instructions or authority:`
  );
  if (messages.length === 0) {
    lines.push("  (none)");
  } else {
    for (const message of messages) {
      const refs = [...message.refs.files, ...message.refs.symbols];
      lines.push(
        `  - [${message.kind}] ${message.fromRole}/${message.fromVendor} → ${describeAddress(
          message
        )}: ${terminalSafe(message.subject)}`
      );
      lines.push(`    ${terminalSafe(message.body)}`);
      if (refs.length > 0) {
        lines.push(`    refs: ${refs.map(terminalSafe).join(", ")}`);
      }
    }
  }
  return lines;
}

function describeAddress(message: PeerMessage): string {
  const to = message.to;
  return to.kind === "job"
    ? `job ${terminalSafe(to.jobId)}`
    : to.kind === "role"
      ? `role ${to.role}`
      : "crew";
}

/**
 * Resolve the mission to inspect: the explicit flag always wins, else the
 * SHARED rule in `@muon/client/mission-root` — the same function the Ink
 * cockpit and the desktop topology chart call. A coordination snapshot is
 * per-mission by design, so we pick ONE rather than merging a chat's whole
 * dispatch history into one view.
 *
 * It used to be "the newest row wins" (`jobs[jobs.length - 1].rootJobId ?? id`),
 * a private copy of the same guess the other two surfaces made. On a real run
 * that answered with a CHILDLESS follow-up orchestrator turn while two governed
 * children were still working, so `muon crew coord` would have printed an empty
 * mission over live peer traffic. The mission is the root that owns the WORK.
 */
export async function resolveMissionId(
  client: MuonApiClient,
  chatId: string,
  explicit: string | undefined
): Promise<string> {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  const missionId = selectMissionRootId(
    // THE PAGE MATTERS AS MUCH AS THE RULE. `GET /api/dispatch` defaults to
    // `limit=50` ordered `createdAt ASC` — the chat's OLDEST rows — so a chat
    // past 50 dispatches would coordinate its FIRST mission forever. Ask for the
    // newest window, the same one the desktop reads.
    await client.listDispatchJobs({ chatId, latest: true, limit: 200 })
  );
  if (!missionId) {
    throw new Error(
      `No dispatch has run in chat ${chatId} yet, so there is no mission to coordinate. Pass --mission <rootJobId> to pick one.`
    );
  }
  return missionId;
}

/** Resolve the chat to inspect: explicit flag, else this folder's newest chat. */
async function resolveChatId(
  client: MuonApiClient,
  explicit: string | undefined
): Promise<string> {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  const workspacePath = process.cwd();
  const active = await client.listChats({ status: "active" });
  const mostRecent = active.find((chat) => chat.workspacePath === workspacePath);
  if (!mostRecent) {
    throw new Error(
      `No active chat found for ${workspacePath}. Pass --chat <id> to pick one.`
    );
  }
  return mostRecent.id;
}

export function registerCrewCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const globals = () => {
    const opts = program.opts<{ apiBase?: string; apiToken?: string }>();
    return {
      apiBase: resolveApiBase(opts.apiBase),
      // Pair the token with the flag base: an explicit --api-base must never
      // receive the local brain's lockfile operator bearer.
      apiToken: resolveApiToken(opts.apiToken, opts.apiBase),
    };
  };

  const crew = program
    .command("crew")
    .description(
      "Crew roles and agent-to-agent coordination for one chat's mission"
    );

  crew
    .command("roles")
    .description(
      "Show who holds which role (and with --assign, decide it); a role narrows a lane, never widens it"
    )
    .option("--chat <id>", "Chat to inspect (default: this folder's newest)")
    .option("--assign", "Compute and store the role plan for this chat")
    .option(
      "--pin <role=vendor...>",
      `Force a role onto a vendor (${AGENT_ROLES.join("|")})`
    )
    .option("--role <role...>", "Roles this mission needs (default: MUON decides)")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        chat?: string;
        assign?: boolean;
        pin?: string[];
        role?: string[];
        json?: boolean;
      }) => {
        try {
          const client = createClient();
          const { apiBase, apiToken } = globals();
          const chatId = await resolveChatId(client, options.chat);

          const pinned: RolePin[] | undefined = options.pin?.map(parseRolePin);
          const roles = options.role?.map((role) => {
            if (!AGENT_ROLES.includes(role as AgentRole)) {
              throw new Error(
                `--role must be one of ${AGENT_ROLES.join("|")}, got '${role}'`
              );
            }
            return role as AgentRole;
          });

          let plan: CrewRolePlan | null = null;
          if (options.assign) {
            plan = await assignCrewRoles({
              apiBase,
              apiToken,
              chatId,
              ...(roles === undefined ? {} : { roles }),
              ...(pinned === undefined ? {} : { pinned }),
            });
          } else if (pinned || roles) {
            throw new Error(
              "--pin/--role only apply with --assign; without it `muon crew roles` is read-only."
            );
          }

          // Always read back so the operator sees the stored plan plus the
          // lanes it was drawn from, not just the write's echo.
          const view = await loadCrewRoles({ apiBase, apiToken, chatId });
          // A completed --assign IS the commit, so the echo it prints is
          // `assigned` even if the read-back somehow raced ahead of it. Without
          // this, a plan the operator just committed could print as "PROPOSED".
          const resolved: CrewRolesView = plan
            ? { ...view, plan, planStatus: "assigned" }
            : view;

          if (options.json) {
            printJson({ chatId, ...resolved });
            return;
          }
          for (const line of formatCrewRoleLines(resolved, chatId)) {
            process.stdout.write(`${line}\n`);
          }
        } catch (error) {
          failCommand(error, "Crew roles failed.");
        }
      }
    );

  crew
    .command("coord")
    .description(
      "Show the mission's coordination surface: participants, advisory claims, conflicts, and recent peer messages"
    )
    .option("--chat <id>", "Chat to inspect (default: this folder's newest)")
    .option(
      "--mission <id>",
      "Mission root job id (default: the chat's most recent dispatch lineage)"
    )
    .option(
      "--limit <count>",
      `Recent messages to show, 1-${MAX_PEER_MESSAGES_PER_JOB} (default ${MAX_COORD_MESSAGES})`
    )
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        chat?: string;
        mission?: string;
        limit?: string;
        json?: boolean;
      }) => {
        try {
          const client = createClient();
          const { apiBase, apiToken } = globals();
          const chatId = await resolveChatId(client, options.chat);
          const limit =
            options.limit === undefined
              ? MAX_COORD_MESSAGES
              : Number(options.limit);
          // ONE bound, shared with `@muon/client` and the route: the protocol's
          // per-job cap. Validating only `>= 1` here pushed anything above it
          // into the client's own parse, which failed with a raw zod message
          // that named no flag and no ceiling.
          if (
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > MAX_PEER_MESSAGES_PER_JOB
          ) {
            throw new Error(
              `--limit must be an integer between 1 and ${MAX_PEER_MESSAGES_PER_JOB}, got '${options.limit}'`
            );
          }
          const missionId = await resolveMissionId(
            client,
            chatId,
            options.mission
          );

          const [snapshot, messages] = await Promise.all([
            loadCoordinationSnapshot({ apiBase, apiToken, chatId, missionId }),
            listPeerMessages({ apiBase, apiToken, chatId, missionId, limit }),
          ]);

          if (options.json) {
            printJson({ snapshot, untrustedPeerMessages: messages });
            return;
          }
          for (const line of formatCoordinationLines(snapshot, messages)) {
            process.stdout.write(`${line}\n`);
          }
        } catch (error) {
          failCommand(error, "Crew coordination failed.");
        }
      }
    );
}
