import type { Command } from "commander";
import {
  CustomAgentStoreError,
  customAgentRegistrationInputSchema,
  listCustomAgents,
  registerCustomAgent,
  removeCustomAgent,
  type UngovernedAgentEntry,
} from "@muon/client";
import { printError, printJson } from "../lib/output.js";

/**
 * ROADMAP P7 — `muon custom-agents register | list | remove`.
 *
 * Deliberately a SEPARATE top-level command from `muon agents` (the FLEET
 * discovery table, `apps/cli/src/commands/agents.ts`): that command lists
 * MUON-managed vendor lanes with a readiness state and a next dispatch
 * command; this one lists an operator's own registered binaries that get
 * exactly one thing — a labelled button that opens THEIR terminal tab. Naming
 * both `agents` would make "how many agents do I have" ambiguous between two
 * answers that must never be added together, so the split lives in the
 * command name itself, not just in a doc comment.
 *
 * Takes NO `MuonApiClient` — every read/write here is a local JSON file
 * (`@muon/client`'s `custom-agents-store`), so this command needs no running
 * brain, exactly like `muon mcp`.
 */
export function registerCustomAgentCommands(program: Command): void {
  const group = program
    .command("custom-agents")
    .description(
      "Runtime-registered ungoverned agents: a terminal-tab-only binary MUON can open, never a dispatchable lane"
    );

  group
    .command("register")
    .argument("<slug>", "lowercase id for this agent, e.g. 'my-local-agent'")
    .requiredOption("--command <bin>", "the binary MUON spawns (resolved against PATH)")
    .option("--name <displayName>", "full label (defaults to the slug)")
    .option("--short-label <label>", "compact label for the terminal tab bar")
    .option("--icon <iconKey>", "glyph key (defaults to 'custom-agent')")
    .option(
      "--arg <value>",
      "an argv entry, repeatable in order (e.g. --arg --flag --arg value)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .option("--json", "print the created entry as JSON")
    .description(
      "Register a runtime custom agent — identity + spawn argv only, never a role, a dispatch seat, or MCP access"
    )
    .action(
      (
        slug: string,
        options: {
          command: string;
          name?: string;
          shortLabel?: string;
          icon?: string;
          arg: string[];
          json?: boolean;
        }
      ) => {
        try {
          const input = customAgentRegistrationInputSchema.parse({
            slug,
            displayName: options.name ?? slug,
            shortLabel: options.shortLabel,
            iconKey: options.icon,
            command: options.command,
            args: options.arg,
          });
          const entry = registerCustomAgent(input);
          if (options.json) {
            printJson(entry);
            return;
          }
          process.stdout.write(
            `registered ${entry.id} (${entry.displayName}) — terminal-tab only, ungoverned: no role, no dispatch, no brain/MCP access\n` +
              `next: muon custom-agents list\n`
          );
        } catch (error) {
          printError(formatCustomAgentError(error));
          process.exitCode = 1;
        }
      }
    );

  group
    .command("list")
    .option("--json", "print as JSON")
    .description("List registered custom agents")
    .action((options: { json?: boolean }) => {
      const entries = listCustomAgents();
      if (options.json) {
        printJson(entries);
        return;
      }
      printCustomAgentTable(entries);
    });

  group
    .command("remove")
    .argument("<id>", "the agent's id, e.g. 'custom:my-local-agent' (the slug alone also works)")
    .description("Remove a registered custom agent")
    .action((rawId: string) => {
      const id = rawId.startsWith("custom:") ? rawId : `custom:${rawId}`;
      const removed = removeCustomAgent(id);
      if (!removed) {
        printError(`no custom agent registered with id '${id}'`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`removed ${id}\n`);
    });
}

function formatCustomAgentError(error: unknown): string {
  if (error instanceof CustomAgentStoreError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "custom agent registration failed";
}

function printCustomAgentTable(entries: UngovernedAgentEntry[]): void {
  if (entries.length === 0) {
    process.stdout.write(
      "no custom agents registered\nnext: muon custom-agents register <slug> --command <bin>\n"
    );
    return;
  }
  process.stdout.write(
    `${"ID".padEnd(30)}${"NAME".padEnd(24)}${"COMMAND".padEnd(20)}TAG\n`
  );
  for (const entry of entries) {
    process.stdout.write(
      `${entry.id.padEnd(30)}${entry.displayName.padEnd(24)}${entry.command.padEnd(20)}Ungoverned\n`
    );
  }
}
