import type { Command } from "commander";
import type { AgentRecord, FleetSnapshot, FleetVendor } from "@muon/client";
import { fleetVendorIds } from "@muon/client/vendors";
import { MuonApiClient } from "../lib/api-client.js";
import { printError, printJson } from "../lib/output.js";
import { exitCodeForError, formatRefusal } from "../lib/refusal.js";

const FLEET_VENDORS: readonly FleetVendor[] = fleetVendorIds();
const FLEET_MAX_PER_VENDOR = 3;

function parseCountOption(value: string, flag: string): number {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > FLEET_MAX_PER_VENDOR
  ) {
    throw new Error(
      `${flag} must be an integer between 0 and ${FLEET_MAX_PER_VENDOR}, got '${value}'.`
    );
  }
  return parsed;
}

function renderCounts(counts: Record<string, number>): string {
  return FLEET_VENDORS.map((vendor) => `${vendor}=${counts[vendor] ?? 0}`).join(
    " "
  );
}

function printAgentTable(agents: AgentRecord[]) {
  if (agents.length === 0) {
    process.stdout.write(
      "no agents, size the fleet with: muon fleet set --claude-code 1\n"
    );
    return;
  }
  for (const agent of agents) {
    const task = agent.currentTaskId ? ` task=${agent.currentTaskId}` : "";
    const session = agent.sessionId ? ` session=${agent.sessionId}` : "";
    process.stdout.write(
      `- ${agent.name.padEnd(16)} ${agent.status.padEnd(8)}${task}${session}\n`
    );
  }
}

function printSnapshot(snapshot: FleetSnapshot) {
  process.stdout.write(`counts: ${renderCounts(snapshot.counts)}\n`);
  printAgentTable(snapshot.agents);
}

export function registerFleetCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const fleet = program
    .command("fleet")
    .description(
      "Agent fleet: 0-3 running instances per vendor (the dispatch semaphore)"
    )
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const snapshot = await createClient().getFleet();
        if (options.json) {
          printJson(snapshot);
          return;
        }
        printSnapshot(snapshot);
      } catch (error) {
        printError(formatRefusal(error, "fleet"));
        process.exitCode = exitCodeForError(error);
      }
    });

  fleet
    .command("set")
    .description(
      "Resize the fleet per vendor (0-3); working agents are never killed by a resize"
    )
    .option("--claude-code <count>", "Target claude-code instance count (0-3)")
    .option("--codex <count>", "Target codex instance count (0-3)")
    .option("--cursor <count>", "Target cursor instance count (0-3)")
    .option("--opencode <count>", "Target opencode instance count (0-3)")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        claudeCode?: string;
        codex?: string;
        cursor?: string;
        opencode?: string;
        json?: boolean;
      }) => {
        try {
          const counts: Partial<Record<FleetVendor, number>> = {};
          if (options.claudeCode !== undefined) {
            counts["claude-code"] = parseCountOption(
              options.claudeCode,
              "--claude-code"
            );
          }
          if (options.codex !== undefined) {
            counts.codex = parseCountOption(options.codex, "--codex");
          }
          if (options.cursor !== undefined) {
            counts.cursor = parseCountOption(options.cursor, "--cursor");
          }
          if (options.opencode !== undefined) {
            counts.opencode = parseCountOption(options.opencode, "--opencode");
          }
          if (Object.keys(counts).length === 0) {
            throw new Error(
              "Provide at least one of --claude-code, --codex, --cursor, --opencode."
            );
          }

          const snapshot = await createClient().setFleet(counts);
          for (const warning of snapshot.warnings ?? []) {
            process.stderr.write(`warning: ${warning}\n`);
          }
          if (options.json) {
            printJson(snapshot);
            return;
          }
          printSnapshot(snapshot);
        } catch (error) {
          printError(formatRefusal(error, "fleet set"));
          process.exitCode = exitCodeForError(error);
        }
      }
    );

  fleet
    .command("agents")
    .description("List fleet agent instances with live status")
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const agents = await createClient().listAgents();
        if (options.json) {
          printJson({ agents });
          return;
        }
        printAgentTable(agents);
      } catch (error) {
        printError(formatRefusal(error, "fleet agents"));
        process.exitCode = exitCodeForError(error);
      }
    });
}
