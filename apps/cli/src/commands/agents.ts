import type { Command } from "commander";
import type { AgentRecord, VendorReadiness } from "@muon/client";
import { MuonApiClient } from "@muon/client";
import { printError, printJson } from "../lib/output.js";
import { exitCodeForError, formatRefusal } from "../lib/refusal.js";

/**
 * TODO 7.4 — `muon agents`: the discovery table every multi-agent CLI is
 * missing. Rows carry name, handle (vendor), stable opaque id, readiness, and
 * the exact next command for the first actionable row.
 */

function readinessFor(
  agent: AgentRecord,
  byVendor: Map<string, VendorReadiness>
): string {
  const row = byVendor.get(agent.vendor);
  if (!row) return "unknown";
  if (!row.installed) return "not-installed";
  if (!row.authenticated) return "signed-out";
  return "ready";
}

function printDiscoveryTable(
  agents: AgentRecord[],
  readiness: VendorReadiness[]
): void {
  const byVendor = new Map(readiness.map((row) => [row.vendor, row]));
  if (agents.length === 0) {
    process.stdout.write(
      "no agents yet\nnext: muon fleet set --claude-code 1\n"
    );
    return;
  }
  process.stdout.write(
    `${"NAME".padEnd(18)}${"HANDLE".padEnd(14)}${"ID".padEnd(38)}${"STATUS".padEnd(10)}READY\n`
  );
  for (const agent of agents) {
    process.stdout.write(
      `${agent.name.padEnd(18)}${agent.vendor.padEnd(14)}${agent.id.padEnd(38)}${String(agent.status).padEnd(10)}${readinessFor(agent, byVendor)}\n`
    );
  }
  const first = agents[0]!;
  const next =
    first.currentJobId != null
      ? `muon dispatch status --job-id ${first.currentJobId}`
      : `muon stream read --agent-id ${first.id}`;
  process.stdout.write(`next: ${next}\n`);
}

export function registerAgentsCommand(
  program: Command,
  createClient: () => MuonApiClient
): void {
  program
    .command("agents")
    .description(
      "Discovery table: name, handle, stable id, readiness — then the next command"
    )
    .option("--json", "Print as JSON")
    .option("--refresh", "Refresh vendor readiness probes")
    .action(async (options: { json?: boolean; refresh?: boolean }) => {
      const client = createClient();
      try {
        const [agents, report] = await Promise.all([
          client.listAgents(),
          client.getFleetReadinessReport({ refresh: options.refresh }),
        ]);
        if (options.json) {
          printJson({
            agents: agents.map((agent) => ({
              id: agent.id,
              name: agent.name,
              handle: agent.vendor,
              status: agent.status,
              readiness: readinessFor(
                agent,
                new Map(report.vendors.map((row) => [row.vendor, row]))
              ),
              currentTaskId: agent.currentTaskId ?? null,
              currentJobId: agent.currentJobId ?? null,
            })),
            next:
              agents[0] == null
                ? "muon fleet set --claude-code 1"
                : agents[0].currentJobId != null
                  ? `muon dispatch status --job-id ${agents[0].currentJobId}`
                  : `muon stream read --agent-id ${agents[0].id}`,
          });
          return;
        }
        printDiscoveryTable(agents, report.vendors);
      } catch (error) {
        printError(formatRefusal(error, "agents"));
        process.exitCode = exitCodeForError(error);
      }
    });
}
