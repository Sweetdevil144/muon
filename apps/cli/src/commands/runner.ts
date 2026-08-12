import { randomBytes } from "node:crypto";
import { failCommand } from "../lib/refusal.js";
import { hostname } from "node:os";
import type { Command } from "commander";
import { runRunnerHost } from "@muon/runner";
import { MuonApiClient } from "../lib/api-client.js";
import { resolveApiBase, resolveAgentToken } from "../lib/config.js";

/**
 * `muon runner`, the persistent local runner (R1). Long-lived: it claims
 * fleet agents, executes dispatch jobs in the task's workspace, streams to the
 * brain, and releases on completion. Because it outlives any chat turn, the
 * super-orchestrator's `dispatch` becomes truly async and the human can
 * steer/interrupt sub-agents across turns. `muon chat` auto-spawns one, so you
 * rarely run this by hand, but it exists for a headless box or a debug tail.
 */
export function registerRunnerCommands(
  program: Command,
  // The long-lived runner authenticates as the AGENT tier. A direct, trusted
  // human launch uses this operator client once to authorize a narrow per-launch
  // lease before entering the runner host; auto-started/sandboxed children
  // inherit an already-authorized lease and never receive operator authority.
  createOperatorClient: () => MuonApiClient
) {
  program
    .command("runner")
    .description(
      "Run the persistent local runner: executes dispatched sub-agent jobs in the background"
    )
    .option("--host <name>", "Runner host label (default: os hostname)")
    .option(
      "--concurrency <n>",
      "Max jobs executing at once (fleet caps still apply)",
      "6"
    )
    .option("--poll-ms <n>", "Queue poll interval in ms", "1500")
    .action(
      async (options: { host?: string; concurrency?: string; pollMs?: string }) => {
        try {
          const rawBaseFlag = program.opts<{ apiBase?: string }>().apiBase;
          const apiBase = resolveApiBase(rawBaseFlag);
          // AGENT-tier token (P3-A): the runner injects it into every dispatched
          // sub-agent's MCP, so untrusted sub-agents get reads + agent-writes but
          // never govern authority. The runner's own claim/heartbeat/update calls
          // are all agent-tier routes, so this token also authenticates its OWN
          // client. Trusted direct launch may briefly use operator authority
          // below to mint the narrow lease; that token is never passed into the
          // runner host or a vendor. Agent coordinates resolve from the lockfile,
          // or from MUON_AGENT_TOKEN + MUON_API_BASE when sandbox-blinded to the
          // data dir (ADR-0010 A2).
          const apiToken = resolveAgentToken(undefined, rawBaseFlag);
          const client = new MuonApiClient(apiBase, fetch, apiToken);
          const host = options.host ?? hostname();
          const inheritedLease =
            process.env.MUON_RUNNER_LEASE_TOKEN?.trim();
          const leaseToken =
            inheritedLease || randomBytes(32).toString("hex");
          if (!inheritedLease) {
            // A direct human launch authorizes its own narrow lease once with
            // operator authority. Auto-started/sandboxed runners inherit a
            // lease already minted by the trusted parent and never see the
            // operator token.
            await createOperatorClient().runnerHeartbeat(
              host,
              process.pid,
              leaseToken
            );
          }
          const concurrency = Math.max(1, Number(options.concurrency ?? 6) || 6);
          const pollMs = Math.max(250, Number(options.pollMs ?? 1500) || 1500);

          // ADR-0010 A2: the supervisor advertises confinement via
          // MUON_SANDBOX_ACTIVE. Surface it so the runner's log states plainly
          // whether the dispatched vendors are blinded to the operator token.
          const confined = process.env.MUON_SANDBOX_ACTIVE === "1";
          await runRunnerHost({
            client,
            host,
            apiBase,
            apiToken,
            leaseToken,
            concurrency,
            pollMs,
            confined,
            output: (line) => process.stdout.write(`${line}\n`),
          });
        } catch (error) {
          failCommand(error, "Runner failed.");
        }
      }
    );
}
